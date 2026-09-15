import { test, mock } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { buildWorkProfile, renderWorkProfile } from "../../src/measurement/work-profile.js"
import { readProfileInput, MAX_INPUT_BYTES } from "../../src/measurement/profile-input.js"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const bytes = (value) => Buffer.from(JSON.stringify(value))
const instant = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()
const script = fileURLToPath(new URL("../../scripts/profile-work.js", import.meta.url))
function fact(id, kind, time, agent = "worker-a", fields = {}, extra = {}) {
  return {
    fact_id: id, kind, agent_id: agent, native_session_id: "session-a",
    timestamp: instant(time),
    source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: id, record_sha256: hash(id) },
    fields, ...extra,
  }
}
function usage(id, agent, call, usage = {}, extra = {}) {
  return fact(id, "model.usage_observation", 500, agent, {}, {
    source_ref: { source_id: "rows-a", native_session_id: "session-a", row_id: Number(id.slice(1)), snapshot_row_sha256: hash(id), logical_table: "usage_rows" },
    parent_tool_call_id: call, native_history_turn_index: 4,
    model: "model-a", initiator: "agent", usage, ...extra,
  })
}
const dimension = (value, unit = "tokens") => ({ value, unit })
function snapshot() {
  return {
    schema_version: 1,
    binding: { native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a", title: "Synthetic bounded job", work_item_id: null, task_ref: null },
    facts: [
      fact("dispatch", "tool.execution_start", 0, null, { toolCallId: "dispatch-a", toolName: "task" }),
      fact("started", "subagent.started", 1, "worker-a", { toolCallId: "dispatch-a" }, { dispatch_tool_call_id: "dispatch-a", structural_parent_agent_id: null, source_event_parent_id: "foreign-event" }),
      fact("returned", "tool.execution_complete", 2, null, { toolCallId: "dispatch-a" }, { returned_agent_id: "worker-a", status: "success" }),
    ],
  }
}
function richSnapshot() {
  const input = snapshot()
  input.facts.push(
    fact("user-1", "user.message", 3),
    fact("turn-1-start", "assistant.turn_start", 4, "worker-a", { turnId: "0", interactionId: "interaction-a" }),
    fact("tool-1-start", "tool.execution_start", 5, "worker-a", { toolCallId: "tool-a", toolName: "command" }),
    fact("hook-1-start", "hook.start", 6, "worker-a", { hookInvocationId: "hook-a", parentToolCallId: "tool-a" }),
    fact("hook-1-end", "hook.end", 7, "worker-a", { hookInvocationId: "hook-a" }, { status: "success" }),
    fact("child-dispatch", "tool.execution_start", 7, "worker-a", { toolCallId: "dispatch-b", toolName: "task" }),
    fact("child-started", "subagent.started", 8, "worker-b", { toolCallId: "dispatch-b" }),
    fact("child-returned", "tool.execution_complete", 9, "worker-a", { toolCallId: "dispatch-b" }, { returned_agent_id: "worker-b", status: "success" }),
    fact("tool-1-end", "tool.execution_complete", 10, "worker-a", { toolCallId: "tool-a" }, { status: "success", exit_code: 2 }),
    fact("turn-1-end", "assistant.turn_end", 11, "worker-a", { turnId: "0" }),
    fact("aggregate", "subagent.completed", 12, "worker-a", {}, { native_aggregate: { totalTokens: dimension(99), totalToolCalls: dimension(2, "tool_calls"), durationMs: dimension(10000, "milliseconds") } }),
    fact("user-2", "user.message", 13),
    fact("turn-2-start", "assistant.turn_start", 14, "worker-a", { turnId: "0" }),
    fact("message-1", "assistant.message", 15, "worker-a", { api_call_id_sha256: hash("same-call") }),
    fact("message-2", "assistant.message", 16, "worker-a", { api_call_id_sha256: hash("same-call") }),
    fact("turn-2-end", "assistant.turn_end", 17, "worker-a", { turnId: "0" }),
    fact("compaction", "session.compaction_complete", 18, "worker-a", {}, { usage: { inputTokens: dimension(100), duration: dimension(3, "native_duration_unit_unspecified") } }),
    fact("child-tool-start", "tool.execution_start", 6, "worker-b", { toolCallId: "child-tool" }),
    fact("child-tool-end", "tool.execution_complete", 9, "worker-b", { toolCallId: "child-tool" }, { status: "failure" }),
    fact("foreign-start", "tool.execution_start", 0, "foreign-worker", { toolCallId: "foreign-tool" }),
    fact("foreign-end", "tool.execution_complete", 90, "foreign-worker", { toolCallId: "foreign-tool" }),
    usage("u1", "worker-a", "dispatch-a", { input_tokens: dimension(10), output_tokens: dimension(null), cache_read_tokens: dimension(5), total_nano_aiu: dimension(100, "nano_aiu"), request_multiplier: dimension(0.5, "native_request_multiplier") }),
    usage("u2", "worker-b", "dispatch-b", { input_tokens: dimension(20), output_tokens: dimension(2) }, { model: "model-b", initiator: null }),
    usage("u3", "worker-a", "another-dispatch", { input_tokens: dimension(999) }),
    usage("u4", null, null, { input_tokens: dimension(999) }),
  )
  return input
}
const profile = (value = snapshot()) => buildWorkProfile(bytes(value))
function evidenceEntry(id, overrides = {}) {
  return {
    evidence_id: id, role: "source_system", claim_type: "mutable_state", class: "measured",
    producer: "source_native", observed_at: instant(0), refs: ["source-native:synthetic-commit"], fact_ids: [],
    ...overrides,
  }
}
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-profile-test-")))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function cli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
}

test("binding requires native dispatch, completion and root start; ancestry ignores event predecessor", () => {
  const p = profile(richSnapshot())
  assert.equal(p.schema_version, 1)
  assert.equal(p.kind, "desk_work_profile")
  assert.equal(p.binding.class, "declared")
  assert.equal(p.binding.canonical_ledger_identity, "unverified")
  assert.deepEqual(p.binding.evidence_fact_ids, ["dispatch", "returned", "started"])
  assert.deepEqual(p.observations.agents.map((a) => a.agent_id), ["worker-a", "worker-b"])
  assert.equal(p.coverage.excluded_facts, 6)
  assert.equal(p.observations.usage.selected_rows, 2)
  assert.equal(p.observations.usage.dimensions.input_tokens.value, 30)
  for (const id of ["dispatch", "returned", "started"]) {
    const input = snapshot()
    input.facts = input.facts.filter((f) => f.fact_id !== id)
    assert.throws(() => profile(input), /root binding/i)
  }
  const wrong = snapshot()
  wrong.facts[2].returned_agent_id = "other-worker"
  assert.throws(() => profile(wrong), /root binding/i)
})

test("structural descendants are admitted, foreign sessions and contradictory parents are not", () => {
  const input = snapshot()
  input.facts.push(fact("child", "subagent.started", 3, "worker-b", { toolCallId: "dispatch-b" }, { structural_parent_agent_id: "worker-a" }))
  input.facts.push(usage("u1", "worker-b", "dispatch-b"))
  const foreign = fact("foreign-session", "subagent.started", 4, "worker-c", { toolCallId: "dispatch-c" }, { structural_parent_agent_id: "worker-a", native_session_id: "session-b" })
  foreign.source_ref.native_session_id = "session-b"
  input.facts.push(foreign)
  assert.deepEqual(profile(input).observations.agents.map((a) => a.agent_id), ["worker-a", "worker-b"])
  input.facts.push(fact("unrelated-owner", "tool.execution_start", 2, "worker-z", { toolCallId: "dispatch-b" }))
  assert.deepEqual(profile(input).observations.agents.map((a) => a.agent_id), ["worker-a", "worker-b"])
  input.facts.push(fact("conflicting-child", "subagent.started", 4, "worker-b", { toolCallId: "different-call" }, { structural_parent_agent_id: "worker-z" }))
  assert.throws(() => profile(input), /lineage/i)
  const cycle = snapshot()
  cycle.facts.push(fact("root-again", "subagent.started", 5, "worker-a", { toolCallId: "different-call" }, { structural_parent_agent_id: "worker-a" }))
  assert.throws(() => profile(cycle), /lineage/i)
})

test("native identity dedup is order independent, alias aware, and rejects every conflicting duplicate", () => {
  const input = richSnapshot()
  const repeat = structuredClone(input.facts[4])
  repeat.fact_id = "alias"
  input.facts.push(repeat, structuredClone(repeat))
  const p = profile(input)
  assert.equal(p.coverage.duplicate_facts, 2)
  assert.equal(p.observations.events.find((f) => f.fact_ids.includes("alias")).fact_ids.length, 2)
  const reversed = structuredClone(input)
  reversed.facts.reverse()
  const q = profile(reversed)
  delete p.source_snapshot_sha256
  delete q.source_snapshot_sha256
  assert.deepEqual(p, q)
  for (const mutate of [
    (f) => { f.timestamp = instant(80) },
    (f) => { f.content = "not retained but conflicting" },
    (f) => { f.source_ref.record_sha256 = hash("changed") },
    (f) => { f.agent_id = "foreign-worker" },
  ]) {
    const copy = structuredClone(input)
    mutate(copy.facts.at(-1))
    assert.throws(() => profile(copy), /conflicting duplicate/i)
    copy.facts.reverse()
    assert.throws(() => profile(copy), /conflicting duplicate/i)
  }
  const aliasConflict = snapshot()
  aliasConflict.facts[1].fact_id = "dispatch"
  assert.throws(() => profile(aliasConflict), /fact_id/i)
  const rows = snapshot()
  rows.facts.push(usage("u1", "worker-a", "dispatch-a"), usage("u1", "worker-a", "dispatch-a", { input_tokens: dimension(1) }))
  assert.throws(() => profile(rows), /conflicting duplicate/i)
})

test("turn IDs reset per interaction; spans distinguish summed latency from interval union and messages", () => {
  const p = profile(richSnapshot())
  const steps = p.observations.operations.assistant_step
  assert.equal(steps.matched, 2)
  assert.equal(steps.summed_latency_ms, 10000)
  assert.equal(steps.interval_union_ms, 10000)
  assert.deepEqual(steps.spans.map((s) => s.interaction), [1, 2])
  assert.equal(p.observations.operations.tool.matched, 3)
  assert.equal(p.observations.operations.tool.summed_latency_ms, 10000)
  assert.equal(p.observations.operations.tool.interval_union_ms, 5000)
  assert.equal(p.observations.operations.hook.matched, 1)
  assert.equal(p.observations.operations.interval_union_ms, 10000)
  assert.equal(p.observations.model_calls.class, "unavailable")
  assert.equal(p.observations.assistant_messages, 2)
  assert.equal(p.observations.critical_path.class, "unavailable")
  const input = snapshot()
  input.facts.push(fact("end", "assistant.turn_end", 3, "worker-a", { turnId: "0" }))
  assert.equal(profile(input).observations.operations.assistant_step.unmatched_ends, 1)
})

test("missing endpoints are gaps and successful transport does not imply successful command", () => {
  const input = richSnapshot()
  input.facts.push(
    fact("missing-end", "tool.execution_start", 20, "worker-a", { toolCallId: "unfinished" }),
    fact("missing-start", "hook.end", 21, "worker-a", { hookInvocationId: "orphan" }),
    fact("zero-end", "tool.execution_complete", 22, "worker-a", { toolCallId: "zero" }, { exit_code: 0 }),
  )
  const p = profile(input)
  assert.equal(p.observations.operations.tool.unmatched_starts, 1)
  assert.equal(p.observations.operations.tool.unmatched_ends, 1)
  assert.equal(p.observations.operations.hook.unmatched_ends, 1)
  assert.equal(p.observations.operations.tool.spans.find((s) => s.operation_id === "unfinished").duration_ms, null)
  assert.equal(p.observations.operations.tool.spans.find((s) => s.operation_id === "tool-a").transport_status, "success")
  assert.equal(p.observations.operations.tool.spans.find((s) => s.operation_id === "tool-a").operation_status, "failure")
  assert.equal(p.observations.operations.tool.spans.find((s) => s.operation_id === "dispatch-b").operation_status, "unknown")
  assert.equal(p.observations.operations.tool.spans.find((s) => s.operation_id === "zero").operation_status, "success")
  assert.equal(p.coverage.missing_operation_endpoints, 3)
  input.facts.find((f) => f.fact_id === "tool-1-end").timestamp = instant(4)
  assert.throws(() => profile(input), /reversed interval/i)
  const ambiguous = richSnapshot()
  ambiguous.facts.push(fact("second-start", "tool.execution_start", 5, "worker-a", { toolCallId: "tool-a" }))
  assert.throws(() => profile(ambiguous), /ambiguous operation/i)
})

test("native action classes come only from actual source records; unsupported classes remain visible coverage gaps", () => {
  const p = profile(richSnapshot())
  const classes = p.coverage.native_action_classes
  for (const name of ["messages", "commands", "delegation_handoffs", "cleanup", "side_effects"]) {
    assert.equal(classes[name].class, "measured", name)
    assert.ok(classes[name].count > 0, name)
  }
  for (const gap of ["file_git_mutations", "review_ci", "waits_retries_errors"]) {
    assert.equal(classes[gap].class, "unavailable", gap)
    assert.equal(classes[gap].count, null, gap)
    assert.match(classes[gap].reason, /capture adapter/i, gap)
  }
  assert.ok(!("mura" in classes) && !("muri" in classes))
  const empty = profile()
  assert.equal(empty.coverage.native_action_classes.commands.class, "measured")
  assert.equal(empty.coverage.native_action_classes.commands.count, 0)
  assert.equal(empty.coverage.native_action_classes.delegation_handoffs.count, 1)
  assert.equal(empty.coverage.native_action_classes.file_git_mutations.class, "unavailable")
})

test("usage dimensions preserve unknowns, partial coverage, native units and separate aggregates", () => {
  const input = richSnapshot()
  const p = profile(input)
  const u = p.observations.usage
  assert.deepEqual(u.dimensions.input_tokens, { value: 30, unit: "tokens", known_rows: 2, unknown_rows: 0 })
  assert.deepEqual(u.dimensions.output_tokens, { value: 2, unit: "tokens", known_rows: 1, unknown_rows: 1 })
  assert.equal(u.dimensions.reasoning_tokens.value, null)
  assert.equal(u.dimensions.reasoning_tokens.unknown_rows, 2)
  assert.equal(u.dimensions.total_nano_aiu.unit, "nano_aiu")
  assert.equal(u.groups.length, 2)
  assert.equal(p.observations.aggregates[0].values.totalTokens.value, 99)
  assert.equal(p.observations.compactions[0].values.duration.unit, "native_duration_unit_unspecified")
  assert.match(p.observations.aggregates[0].caution, /not final/i)
  assert.match(p.observations.compactions[0].caution, /overlap/i)
  assert.equal(p.outcome.acceptance, "unassessed")
  assert.equal(p.outcome.status, "unknown")
  assert.equal(profile().observations.usage.dimensions.input_tokens.value, null)
  assert.equal(profile().observations.operations.tool.interval_union_ms, null)
  const row = input.facts.find((f) => f.fact_id === "u1")
  row.usage.input_tokens = dimension(Number.MAX_SAFE_INTEGER)
  assert.throws(() => profile(input), /safe|overflow/i)
})

test("episodes cite actual facts without allocating tokens or claiming defect rework or acceptance", () => {
  const input = richSnapshot()
  input.source_refs = ["source:synthetic"]
  input.coverage_refs = ["coverage:synthetic"]
  input.episodes = [{ episode_id: "correction", label: "Scope correction", class: "declared", fact_ids: ["user-2", "turn-2-end"], output_refs: ["artifact:one"], evidence_refs: ["evidence:one"] }]
  input.outcome = { acceptance: "declared", status: "accepted", evidence_refs: ["receipt:one"], artifact_refs: ["artifact:one"] }
  const p = profile(input)
  assert.equal(p.episodes[0].token_usage.class, "unavailable")
  assert.equal(p.episodes[0].class, "declared")
  assert.equal(p.episodes[0].lean, null)
  assert.deepEqual(p.evidence, [])
  assert.equal(p.outcome.acceptance, "declared")
  assert.equal(p.coverage.independent_acceptance.class, "unavailable")
  assert.deepEqual(p.coverage.source_refs, input.source_refs)
  input.episodes[0].class = "inferred"
  assert.equal(profile(input).episodes[0].class, "inferred")
  input.episodes[0].fact_ids = ["not-a-fact"]
  assert.throws(() => profile(input), /episode/i)
  input.episodes[0].fact_ids = ["dispatch"]
  assert.throws(() => profile(input), /episode/i)
})

test("M3 profile requires a bound Desk work item", () => {
  const input = snapshot()
  input.binding_mode = "desk_work_item"
  assert.throws(() => profile(input), /requires work_item_id and task_ref/u)
})

test("legacy unbound specimen remains readable", () => {
  assert.equal(profile(snapshot()).binding.work_item_id, null)
  assert.equal(profile(snapshot()).binding.binding_mode, null)
})

test("desk_work_item binding mode accepts a fully bound reference and still labels the association declared until T28 checks the ledger", () => {
  const input = snapshot()
  input.binding_mode = "desk_work_item"
  input.binding.work_item_id = "work-a"
  input.binding.task_ref = "task:synthetic-work"
  const p = profile(input)
  assert.equal(p.binding.binding_mode, "desk_work_item")
  assert.equal(p.binding.class, "declared")
  assert.equal(p.binding.canonical_ledger_identity, "unverified")
  const partial = snapshot()
  partial.binding_mode = "desk_work_item"
  partial.binding.work_item_id = "work-a"
  assert.throws(() => profile(partial), /requires work_item_id and task_ref/u)
})

test("an unsupported binding_mode value refuses instead of being silently ignored", () => {
  const input = snapshot()
  input.binding_mode = "native_ledger"
  assert.throws(() => profile(input), /binding_mode/i)
})

test("typed evidence cites in-scope facts, honors role/claim combinations and carries a declared Lean interpretation", () => {
  const input = richSnapshot()
  input.evidence = [
    evidenceEntry("intent-1", { role: "desk", claim_type: "intent", class: "declared", producer: "agent_annotation", fact_ids: [] }),
    evidenceEntry("state-1", { fact_ids: ["tool-1-end"] }),
    evidenceEntry("exec-1", { role: "session_history", claim_type: "execution", class: "measured", producer: "source_native", fact_ids: [] }),
    evidenceEntry("endpoint-1", { role: "desk", claim_type: "endpoint", class: "declared", producer: "agent_annotation", fact_ids: [] }),
    evidenceEntry("outcome-1", { role: "source_system", claim_type: "outcome", class: "measured", producer: "independent_evaluator", fact_ids: [] }),
  ]
  input.episodes = [{
    episode_id: "correction", label: "Scope correction", class: "declared",
    fact_ids: ["user-2", "turn-2-end"], output_refs: [], evidence_refs: [],
    lean: { lean_class: "necessary_non_value", rationale: "Verification protects the accepted endpoint criterion.", evidence_ids: ["state-1"], waste_kind: null },
  }]
  const p = profile(input)
  assert.equal(p.evidence.length, 5)
  assert.deepEqual(p.evidence.map((e) => e.evidence_id), ["endpoint-1", "exec-1", "intent-1", "outcome-1", "state-1"])
  assert.equal(p.episodes[0].lean.lean_class, "necessary_non_value")
  assert.equal(p.episodes[0].lean.waste_kind, null)
  assert.deepEqual(p.episodes[0].lean.evidence_ids, ["state-1"])
  assert.ok(!("mura" in p) && !("muri" in p))
})

test("a declared-intent claim cannot masquerade as source-system live state, and role/claim combinations follow Desk/source/session ownership", () => {
  for (const [claim_type, badRole] of [["intent", "source_system"], ["authority", "session_history"], ["mutable_state", "desk"], ["execution", "desk"], ["endpoint", "source_system"]]) {
    const input = snapshot()
    input.evidence = [evidenceEntry("bad-1", { role: badRole, claim_type })]
    assert.throws(() => profile(input), /role|claim/i, `${claim_type}/${badRole}`)
  }
  const outcomeInput = snapshot()
  outcomeInput.evidence = [evidenceEntry("ok-desk", { role: "desk", claim_type: "outcome" }), evidenceEntry("ok-source", { role: "source_system", claim_type: "outcome" })]
  assert.equal(profile(outcomeInput).evidence.length, 2)
})

test("duplicate evidence IDs refuse in either input order", () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const input = snapshot()
    input.evidence = order.map((tag) => evidenceEntry("dup", { claim_type: tag === "a" ? "mutable_state" : "execution", role: tag === "a" ? "source_system" : "session_history" }))
    assert.throws(() => profile(input), /duplicate/i)
  }
})

test("evidence citing an out-of-scope fact ID refuses", () => {
  const input = snapshot()
  input.evidence = [evidenceEntry("e1", { fact_ids: ["not-a-fact"] })]
  assert.throws(() => profile(input), /evidence|out-of-scope/i)
})

test("unsupported evidence and lean enum values refuse rather than being silently accepted", () => {
  for (const mutate of [
    (e) => { e.role = "unknown_role" },
    (e) => { e.claim_type = "unknown_claim" },
    (e) => { e.class = "unknown_class" },
    (e) => { e.producer = "unknown_producer" },
  ]) {
    const input = snapshot()
    const entry = evidenceEntry("e1")
    mutate(entry)
    input.evidence = [entry]
    assert.throws(() => profile(input), /evidence|role|claim|class|producer/i)
  }
  const leanInput = snapshot()
  leanInput.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent" })]
  leanInput.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "unknown_lean", rationale: "x", evidence_ids: ["e1"], waste_kind: null } }]
  assert.throws(() => profile(leanInput), /lean/i)
  const wasteInput = snapshot()
  wasteInput.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent" })]
  wasteInput.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "muda", rationale: "x", evidence_ids: ["e1"], waste_kind: "unknown_waste" } }]
  assert.throws(() => profile(wasteInput), /waste/i)
})

test("a Lean annotation without rationale refuses", () => {
  const input = snapshot()
  input.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent" })]
  input.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "muda", rationale: "", evidence_ids: ["e1"], waste_kind: null } }]
  assert.throws(() => profile(input), /rationale/i)
})

test("raw transcript-shaped evidence fields refuse rather than silently dropping", () => {
  const input = snapshot()
  const entry = evidenceEntry("e1")
  entry.content = "PRIVATE_PAYLOAD"
  input.evidence = [entry]
  assert.throws(() => profile(input), /evidence/i)
})

test("value_adding requires an accepted endpoint criterion and an independent-evaluator outcome reference, not a declared producer label alone", () => {
  const input = snapshot()
  input.evidence = [evidenceEntry("self-1", { role: "desk", claim_type: "outcome", class: "declared", producer: "agent_annotation" })]
  input.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "value_adding", rationale: "Self-declared.", evidence_ids: ["self-1"], waste_kind: null } }]
  input.outcome = { acceptance: "declared", status: "accepted", evidence_refs: ["r"], artifact_refs: [] }
  assert.throws(() => profile(input), /independent[_-]evaluator|value_adding/i)
  input.evidence.push(evidenceEntry("indep-1", { role: "source_system", claim_type: "outcome", class: "measured", producer: "independent_evaluator" }))
  input.episodes[0].lean.evidence_ids = ["self-1", "indep-1"]
  assert.equal(profile(input).episodes[0].lean.lean_class, "value_adding")
  input.outcome.status = "not_accepted"
  assert.throws(() => profile(input), /accepted endpoint|value_adding/i)
})

test("value_adding cannot be satisfied by an unavailable-class independent-evaluator outcome entry; the label alone is not the assessment", () => {
  const input = snapshot()
  input.evidence = [evidenceEntry("unassessed-indep", { role: "source_system", claim_type: "outcome", class: "unavailable", producer: "independent_evaluator" })]
  input.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "value_adding", rationale: "Labelled but unassessed.", evidence_ids: ["unassessed-indep"], waste_kind: null } }]
  input.outcome = { acceptance: "declared", status: "accepted", evidence_refs: ["r"], artifact_refs: [] }
  assert.throws(() => profile(input), /independent[_-]evaluator|value_adding/i)
  input.evidence[0].class = "declared"
  assert.throws(() => profile(input), /independent[_-]evaluator|value_adding/i)
  input.evidence[0].class = "measured"
  assert.equal(profile(input).episodes[0].lean.lean_class, "value_adding")
})

test("no mura or muri schema field is introduced and a large token count cannot itself establish muda or muri", () => {
  const input = richSnapshot()
  input.facts.push(usage("u5", "worker-a", "dispatch-a", { input_tokens: dimension(900000) }))
  const p = profile(input)
  assert.ok(!("mura" in p) && !("muri" in p))
  assert.ok(!("mura" in p.coverage) && !("muri" in p.coverage))
  for (const episode of p.episodes) assert.ok(!("mura" in episode) && !("muri" in episode))
})

test("evidence and Lean annotation cannot reset or upgrade the declared binding identity", () => {
  const input = snapshot()
  input.binding_mode = "desk_work_item"
  input.binding.work_item_id = "work-a"
  input.binding.task_ref = "task:synthetic"
  input.evidence = [evidenceEntry("rework-1", { role: "desk", claim_type: "outcome", class: "declared", producer: "independent_evaluator" })]
  input.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "muda", rationale: "Rework example.", evidence_ids: ["rework-1"], waste_kind: "defects_rework" } }]
  const p = profile(input)
  assert.equal(p.binding.class, "declared")
  assert.equal(p.binding.canonical_ledger_identity, "unverified")
})

test("evidence references remain inert bounded strings, deduplicated and sorted like other reference arrays", () => {
  const input = snapshot()
  input.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent", refs: ["b:two", "a:one", "a:one"] })]
  const p = profile(input)
  assert.deepEqual(p.evidence[0].refs, ["a:one", "b:two"])
})

test("evidence and lean citation arrays remain bounded at the existing 100-entry ceiling", () => {
  const manyEvidence = snapshot()
  manyEvidence.evidence = Array.from({ length: 101 }, (_, index) => evidenceEntry(`e${index}`, { role: "desk", claim_type: "intent" }))
  assert.throws(() => profile(manyEvidence), /100|limit|evidence/i)
  const manyFactIds = snapshot()
  manyFactIds.facts.push(...Array.from({ length: 100 }, (_, index) => fact(`extra-${index}`, "user.message", 20 + index, "worker-a")))
  manyFactIds.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent", fact_ids: Array.from({ length: 101 }, (_, index) => `extra-${index}`).slice(0, 101) })]
  assert.throws(() => profile(manyFactIds), /100|limit|evidence/i)
  const manyLeanEvidenceIds = snapshot()
  manyLeanEvidenceIds.evidence = [evidenceEntry("e1", { role: "desk", claim_type: "intent" })]
  manyLeanEvidenceIds.episodes = [{ episode_id: "a", label: "A", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], lean: { lean_class: "muda", rationale: "x", evidence_ids: Array(101).fill("e1"), waste_kind: null } }]
  assert.throws(() => profile(manyLeanEvidenceIds), /100|limit|lean/i)
})

test("the CLI renders typed evidence and Lean interpretation deterministically in JSON and Markdown, and refuses invalid annotations without partial output", (t) => {
  const dir = temporary(t)
  const file = path.join(dir, "snapshot.json")
  const input = richSnapshot()
  input.evidence = [evidenceEntry("state-1", { fact_ids: ["tool-1-end"] })]
  input.episodes = [{ episode_id: "correction", label: "Scope correction", class: "declared", fact_ids: ["user-2", "turn-2-end"], output_refs: [], evidence_refs: [], lean: { lean_class: "necessary_non_value", rationale: "Verification protects the accepted endpoint criterion.", evidence_ids: ["state-1"], waste_kind: null } }]
  fs.writeFileSync(file, bytes(input))
  const jsonResult = cli(["--input", file, "--format", "json"])
  assert.equal(jsonResult.status, 0, jsonResult.stderr)
  const parsed = JSON.parse(jsonResult.stdout)
  assert.equal(parsed.evidence[0].evidence_id, "state-1")
  assert.equal(parsed.episodes[0].lean.lean_class, "necessary_non_value")
  const markdownResult = cli(["--input", file, "--format", "markdown"])
  assert.equal(markdownResult.status, 0, markdownResult.stderr)
  assert.match(markdownResult.stdout, /state-1/)
  assert.match(markdownResult.stdout, /necessary non value/)
  const invalidFile = path.join(dir, "invalid.json")
  const invalidInput = structuredClone(input)
  invalidInput.evidence[0].role = "not_a_role"
  fs.writeFileSync(invalidFile, bytes(invalidInput))
  for (const format of ["json", "markdown"]) {
    const failing = cli(["--input", invalidFile, "--format", format])
    assert.notEqual(failing.status, 0)
    assert.equal(failing.stdout, "")
    assert.match(failing.stderr, /profile-work:/)
  }
})

test("output is deterministic, bounded, sanitized and carries the actual byte hash in both formats", () => {
  const input = richSnapshot()
  input.binding.title = "x|\n\u001b[31m<unsafe>&`"
  input.facts[4].content = "PRIVATE_PAYLOAD"
  input.facts[4].fields.arguments = "PRIVATE_PAYLOAD"
  input.facts[4].fields.reasoning = "PRIVATE_PAYLOAD"
  input.facts[4].fields.encrypted_content = "PRIVATE_PAYLOAD"
  const raw = Buffer.concat([bytes(input), Buffer.from("\n ")])
  const p = buildWorkProfile(raw)
  assert.equal(p.source_snapshot_sha256, hash(raw))
  const json = renderWorkProfile(p, "json")
  const markdown = renderWorkProfile(p, "markdown")
  assert.equal(JSON.parse(json).source_snapshot_sha256, hash(raw))
  assert.ok(markdown.includes(hash(raw)))
  assert.ok(markdown.includes("Event/source trail"))
  assert.ok(markdown.includes("Scope") && markdown.includes("unknown"))
  assert.ok(!markdown.includes("\u001b") && !markdown.includes("<unsafe>"))
  assert.ok(!json.includes("PRIVATE_PAYLOAD") && !markdown.includes("PRIVATE_PAYLOAD"))
  assert.ok(markdown.includes("&#124;") && markdown.includes("\\u000a"))
  assert.throws(() => renderWorkProfile(p, "html"), /format/i)
})

test("dense Markdown is a readable summary while JSON retains the complete evidence", () => {
  const input = richSnapshot()
  input.source_refs = ["source:synthetic-dense-capture"]
  input.coverage_refs = ["coverage:synthetic-selected-rows"]
  input.episodes = [{ episode_id: "correction", label: "Scope correction", class: "inferred", fact_ids: ["user-2", "turn-2-end"], output_refs: ["artifact:synthetic-revision"], evidence_refs: ["evidence:synthetic-correction"] }]
  for (let index = 0; index < 100; index++) {
    const call = `opaque-operation-${index}`
    input.facts.push(
      fact(`machine-only-start-${index}`, "tool.execution_start", 100 + index * 2, "worker-a", { toolCallId: call, toolName: "synthetic.command" }),
      fact(`machine-only-end-${index}`, "tool.execution_complete", 101 + index * 2, "worker-a", { toolCallId: call }, { status: "success", exit_code: index % 3 === 0 ? 0 : index % 3 === 1 ? 2 : null }),
    )
  }
  const p = profile(input)
  const json = renderWorkProfile(p, "json")
  const markdown = renderWorkProfile(p, "markdown")
  assert.equal(p.observations.operations.tool.matched, 103)
  assert.ok(json.includes("machine-only-start-99") && json.includes("opaque-operation-99"))
  assert.ok(!markdown.includes("machine-only-start-") && !markdown.includes("opaque-operation-"), "full event/operation identities belong in the JSON trail, not wide Markdown tables")
  assert.match(markdown, /Activity summary/)
  assert.match(markdown, /Tool calls/)
  assert.match(markdown, /Scope correction/)
  assert.match(markdown, /inferred/)
  assert.match(markdown, /artifact:synthetic-revision/)
  assert.match(markdown, /source:synthetic-dense-capture/)
  assert.match(markdown, /coverage:synthetic-selected-rows/)
  assert.match(markdown, /unassessed/)
  assert.match(markdown, /JSON output/)
  assert.ok(!markdown.includes("native&#95;session&#95;id"), "binding must use readable labels rather than a serialized JSON object")
  for (const line of markdown.split("\n").filter((line) => line.startsWith("|"))) {
    assert.ok(line.split("|").length <= 7, "summary tables must not exceed five columns")
  }
})

test("malformed snapshots, records, counters and annotations refuse instead of dropping errors", () => {
  for (const raw of [Buffer.from(""), Buffer.from("{"), Buffer.from([0xff]), bytes(null), bytes([]), bytes({}), bytes({ schema_version: 2 }), bytes({ ...snapshot(), facts: [] })]) {
    assert.throws(() => buildWorkProfile(raw))
  }
  assert.throws(() => buildWorkProfile("not bytes"), /bytes|buffer/i)
  const mutations = [
    (s) => { s.binding = null },
    (s) => { s.binding.work_item_id = 9 },
    (s) => { s.binding.root_agent_id = "" },
    (s) => { s.binding.title = "x".repeat(2049) },
    (s) => { s.facts = {} },
    (s) => { s.facts[0] = null },
    (s) => { s.facts[0].kind = "unsupported.kind" },
    (s) => { s.facts[0].timestamp = "2026-01-01" },
    (s) => { s.facts[0].agent_id = 4 },
    (s) => { s.facts[0].source_ref = {} },
    (s) => { s.facts[0].source_ref.native_session_id = "wrong" },
    (s) => { s.facts[0].source_ref.record_sha256 = "bad" },
    (s) => { s.facts[0].source_ref.byte_offset = -1 },
    (s) => { s.facts[0].source_ref.row_id = 4 },
    (s) => { s.facts[0].fields = [] },
    (s) => { s.facts[0].fields.toolCallId = null },
    (s) => { s.facts[0].fields.toolName = {} },
    (s) => { s.facts[1].dispatch_tool_call_id = "conflict" },
    (s) => { s.facts[2].exit_code = 0.1 },
    (s) => { s.source_refs = [42] },
    (s) => { s.coverage_refs = null },
    (s) => { s.episodes = {} },
    (s) => { s.episodes = [{ episode_id: "bad" }] },
    (s) => { s.outcome = { acceptance: "independent" } },
    (s) => { s.outcome = { acceptance: "unassessed", status: "accepted", evidence_refs: [], artifact_refs: [] } },
    (s) => { s.outcome = { acceptance: "declared", status: "accepted", evidence_refs: [], artifact_refs: [] } },
  ]
  for (const mutate of mutations) {
    const input = snapshot()
    mutate(input)
    assert.throws(() => profile(input), mutate.toString())
  }
  for (const invalid of [-1, 0.2, Number.MAX_SAFE_INTEGER + 1, "2", {}, false]) {
    const input = snapshot()
    input.facts.push(usage("u1", "worker-a", "dispatch-a", { input_tokens: dimension(invalid) }))
    assert.throws(() => profile(input), /usage|counter/i)
  }
  for (const bad of [
    { input_tokens: dimension(1, "dollars") },
    { unsupported_counter: dimension(1) },
    { duration_ms: dimension(-1, "milliseconds") },
    { output_ttft_ms: dimension(-1, "milliseconds") },
    { input_tokens: null },
  ]) {
    const input = snapshot()
    input.facts.push(usage("u1", "worker-a", "dispatch-a", bad))
    assert.throws(() => profile(input), /usage|counter/i)
  }
})

test("byte, fact, annotation and structure ceilings refuse without truncation", () => {
  assert.equal(MAX_INPUT_BYTES, 16 * 1024 * 1024)
  assert.throws(() => buildWorkProfile(Buffer.alloc(MAX_INPUT_BYTES + 1)), /limit/i)
  const input = snapshot()
  input.facts = Array.from({ length: 10001 }, () => input.facts[0])
  assert.throws(() => profile(input), /10000|10,000|limit/i)
  const atLimit = snapshot()
  while (atLimit.facts.length < 10000) atLimit.facts.push(structuredClone(atLimit.facts[0]))
  assert.equal(profile(atLimit).coverage.input_facts, 10000)
  const deep = snapshot()
  deep.ignored = Array.from({ length: 40 }).reduce((v) => [v], 0)
  assert.throws(() => profile(deep), /structure|depth/i)
  const wide = snapshot()
  wide.ignored = Array(500001).fill(0)
  assert.throws(() => profile(wide), /structure|values/i)
  const refs = snapshot()
  refs.source_refs = Array(101).fill("ref")
  assert.throws(() => profile(refs), /limit|reference/i)
})

test("bounded reader admits exact bytes and refuses links, directories, missing files and overflow", (t) => {
  const dir = temporary(t)
  const file = path.join(dir, "snapshot.json")
  const raw = bytes(snapshot())
  fs.writeFileSync(file, raw)
  assert.deepEqual(readProfileInput(file), raw)
  const link = path.join(dir, "link.json")
  fs.symlinkSync(file, link)
  assert.throws(() => readProfileInput(link), /link|regular/i)
  fs.unlinkSync(link)
  fs.linkSync(file, link)
  assert.throws(() => readProfileInput(file), /link|regular/i)
  fs.unlinkSync(link)
  assert.throws(() => readProfileInput(dir), /regular/i)
  assert.throws(() => readProfileInput(path.join(dir, "absent")), /ENOENT/)
  fs.truncateSync(file, MAX_INPUT_BYTES + 1)
  assert.throws(() => readProfileInput(file), /limit/i)
  fs.truncateSync(file, MAX_INPUT_BYTES)
  assert.equal(readProfileInput(file).length, MAX_INPUT_BYTES)
  assert.throws(() => readProfileInput(""), /path/i)
  const directoryLink = path.join(dir, "parent-link")
  fs.symlinkSync(dir, directoryLink)
  assert.throws(() => readProfileInput(path.join(directoryLink, "snapshot.json")), /link/i)
})

test("reader closes its descriptor and rejects file or ancestor replacement, growth and read failures", (t) => {
  const dir = temporary(t)
  const file = path.join(dir, "snapshot.json")
  const originalRead = fs.readSync
  const originalFstat = fs.fstatSync
  for (const change of ["growth", "shrink", "replace", "hardlink", "read-error", "opened-identity", "opened-not-regular", "timestamp", "ancestor"]) {
    fs.writeFileSync(file, bytes(snapshot()))
    let closeCalls = 0
    let changed = false
    let inputFd
    const close = fs.closeSync
    mock.method(fs, "closeSync", (...args) => { if (args[0] === inputFd) closeCalls++; return close(...args) })
    mock.method(fs, "fstatSync", (...args) => {
      inputFd ??= args[0]
      const stat = originalFstat(...args)
      if (change === "opened-identity") return { ...stat, ino: stat.ino + 1n, isFile: () => true }
      if (change === "opened-not-regular") return { ...stat, isFile: () => false }
      return stat
    })
    if (!change.startsWith("opened-")) {
      mock.method(fs, "readSync", (...args) => {
        if (!changed) {
          changed = true
          if (change === "growth") fs.appendFileSync(file, "more")
          if (change === "shrink") fs.truncateSync(file, 1)
          if (change === "replace") { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, bytes(snapshot())) }
          if (change === "hardlink") fs.linkSync(file, `${file}.link`)
          if (change === "read-error") throw new Error("synthetic read failure")
          if (change === "timestamp") fs.utimesSync(file, new Date(0), new Date(0))
          if (change === "ancestor") { fs.renameSync(dir, `${dir}-moved`); fs.mkdirSync(dir); fs.writeFileSync(file, bytes(snapshot())) }
        }
        return originalRead(...args)
      })
    }
    try {
      assert.throws(() => readProfileInput(file), /changed|regular|read failure/i, change)
      assert.equal(closeCalls, 1, change)
    } finally {
      mock.restoreAll()
      if (change === "ancestor") fs.rmSync(`${dir}-moved`, { recursive: true })
      for (const suffix of [".old", ".link"]) fs.rmSync(`${file}${suffix}`, { force: true })
    }
  }
})

test("actual CLI only writes a profile after complete validation; both formats bind exact input bytes", (t) => {
  const dir = temporary(t)
  const file = path.join(dir, "snapshot.json")
  const raw = bytes(richSnapshot())
  fs.writeFileSync(file, raw)
  for (const format of ["json", "markdown"]) {
    const result = cli(["--input", file, "--format", format])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.ok(result.stdout.includes(hash(raw)))
    if (format === "json") assert.equal(JSON.parse(result.stdout).kind, "desk_work_profile")
  }
  assert.equal(cli(["--format", "json", "--input", file]).status, 0)
  for (const args of [[], ["--input", file], ["--input", file, "--format", "xml"], ["--input", file, "--input", file], ["--unknown", file, "--format", "json"], ["--input", file, "--format", "json", "extra"], ["--input", `${file}.absent`, "--format", "json"]]) {
    const result = cli(args)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /profile-work:/)
  }
  for (const raw of [Buffer.from("{PRIVATE_PAYLOAD"), bytes({ schema_version: 2 }), bytes({ ...snapshot(), facts: [] }), Buffer.alloc(MAX_INPUT_BYTES + 1)]) {
    fs.writeFileSync(file, raw)
    const result = cli(["--input", file, "--format", "json"])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    assert.ok(!result.stderr.includes("PRIVATE_PAYLOAD"))
  }
})
