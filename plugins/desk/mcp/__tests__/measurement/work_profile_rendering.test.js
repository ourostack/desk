import { test } from "node:test"
import { strict as assert } from "node:assert"
import { buildWorkProfile, renderWorkProfile } from "../../src/measurement/work-profile.js"

test("reading summaries label missing endpoints and preserve supplied declared binding references", () => {
  const fact = (id, kind, agent_id, fields, extra = {}) => ({
    fact_id: id, kind, agent_id, fields, ...extra,
    native_session_id: "session-a", timestamp: "2026-01-01T00:00:00Z",
    source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: id },
  })
  const input = {
    schema_version: 1,
    binding_mode: "desk_work_item",
    binding: { native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a", title: "Synthetic partial work", work_item_id: "work-a", task_ref: "task:synthetic-work" },
    facts: [
      fact("dispatch", "tool.execution_start", null, { toolCallId: "dispatch-a" }),
      fact("started", "subagent.started", "worker-a", { toolCallId: "dispatch-a" }),
      fact("returned", "tool.execution_complete", null, { toolCallId: "dispatch-a" }, { returned_agent_id: "worker-a" }),
      fact("unfinished", "tool.execution_start", "worker-a", { toolCallId: "unfinished-call" }),
      fact("orphan-hook", "hook.end", "worker-a", { hookInvocationId: "orphan-hook-call" }),
      fact("orphan-return", "tool.execution_complete", "worker-a", { toolCallId: "orphan-call" }),
    ],
  }
  const profile = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  const markdown = renderWorkProfile(profile, "markdown")
  assert.ok(markdown.includes("| Tool calls | 0 | 1 | 1 |"))
  assert.ok(markdown.includes("| Hook callbacks | 0 | 1 | 0 |"))
  assert.ok(markdown.includes("| Tool calls | unknown | unknown |"))
  assert.ok(markdown.includes("| Transport status not reported | 1 |"))
  assert.ok(markdown.includes("| Underlying exit code not reported | 1 |"))
  assert.ok(markdown.includes("Declared work item: work-a. Canonical ledger identity: unverified."))
  assert.ok(markdown.includes("Declared task reference: task:synthetic-work"))
  assert.ok(markdown.includes("Binding mode: desk_work_item"))
  assert.ok(markdown.includes("No episode annotations supplied"))
  assert.equal(profile.coverage.missing_operation_endpoints, 3)
})

test("unsupported native action classes render as an explicit coverage gap, not a fabricated zero", () => {
  const fact = (id, kind, agent_id, fields, extra = {}) => ({
    fact_id: id, kind, agent_id, fields, ...extra,
    native_session_id: "session-a", timestamp: "2026-01-01T00:00:00Z",
    source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: id },
  })
  const input = {
    schema_version: 1,
    binding: { native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a", title: "Synthetic gap job", work_item_id: null, task_ref: null },
    facts: [
      fact("dispatch", "tool.execution_start", null, { toolCallId: "dispatch-a" }),
      fact("started", "subagent.started", "worker-a", { toolCallId: "dispatch-a" }),
      fact("returned", "tool.execution_complete", null, { toolCallId: "dispatch-a" }, { returned_agent_id: "worker-a" }),
    ],
  }
  const profile = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  assert.equal(profile.coverage.native_action_classes.file_git_mutations.class, "unavailable")
  assert.equal(profile.coverage.native_action_classes.file_git_mutations.count, null)
  const markdown = renderWorkProfile(profile, "markdown")
  const json = renderWorkProfile(profile, "json")
  assert.match(markdown, /file.git.mutation/i)
  assert.ok(!markdown.includes("file_git_mutations: 0"), "a coverage gap must not read like a measured zero")
  assert.equal(JSON.parse(json).coverage.native_action_classes.file_git_mutations.count, null)
})

test("a frozen prior-profile-object shape, built and stored before evidence/native-action-class/binding_mode/lean existed, still renders without throwing or fabricating measured zeros", () => {
  // This is the exact shape buildWorkProfile returned before this task: no top-level `evidence`, no
  // `coverage.native_action_classes`, no `binding.binding_mode`, and episodes with no `lean` member at all
  // (not even `lean: null` — the key is simply absent, as a historical stored artifact would have it).
  const priorProfile = {
    schema_version: 1,
    kind: "desk_work_profile",
    source_snapshot_sha256: "0".repeat(64),
    binding: {
      native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a",
      title: "Frozen prior profile", work_item_id: null, task_ref: null,
      class: "declared", canonical_ledger_identity: "unverified", evidence_fact_ids: ["dispatch", "returned", "started"],
    },
    coverage: {
      input_facts: 3, unique_facts: 3, duplicate_facts: 0, included_facts: 1, excluded_facts: 2,
      missing_operation_endpoints: 0, source_refs: [], coverage_refs: [],
      full_job_usage: { class: "unavailable", value: null, reason: "x" },
      parent_overhead: { class: "unavailable", value: null, reason: "x" },
      independent_acceptance: { class: "unavailable", value: null, reason: "x" },
      causal_productivity: { class: "unavailable", value: null, reason: "x" },
      note: "x",
    },
    observations: {
      agents: [], operations: { tool: { matched: 0, unmatched_starts: 0, unmatched_ends: 0, summed_latency_ms: null, interval_union_ms: null, spans: [] }, hook: { matched: 0, unmatched_starts: 0, unmatched_ends: 0, summed_latency_ms: null, interval_union_ms: null, spans: [] }, assistant_step: { matched: 0, unmatched_starts: 0, unmatched_ends: 0, summed_latency_ms: null, interval_union_ms: null, spans: [] }, interval_union_ms: null, semantics: "x" },
      usage: { class: "measured", scope: "x", selected_rows: 0, dimensions: {}, groups: [], caution: "x" },
      assistant_messages: 0, model_calls: { class: "unavailable", value: null, reason: "x" }, critical_path: { class: "unavailable", value: null, reason: "x" },
      aggregates: [], compactions: [], events: [],
    },
    episodes: [{ episode_id: "a", label: "Prior episode", class: "declared", fact_ids: ["started"], output_refs: [], evidence_refs: [], token_usage: { class: "unavailable", value: null, reason: "x" } }],
    outcome: { acceptance: "unassessed", status: "unknown", evidence_refs: [], artifact_refs: [] },
  }
  assert.ok(!("evidence" in priorProfile), "fixture must omit the new top-level evidence field entirely")
  assert.ok(!("native_action_classes" in priorProfile.coverage), "fixture must omit the new coverage field entirely")
  assert.ok(!("binding_mode" in priorProfile.binding), "fixture must omit the new binding field entirely")
  assert.ok(!("lean" in priorProfile.episodes[0]), "fixture must omit the new episode field entirely")
  for (const format of ["markdown", "json"]) {
    const rendered = renderWorkProfile(priorProfile, format)
    assert.ok(rendered.length > 0, format)
  }
  const markdown = renderWorkProfile(priorProfile, "markdown")
  assert.ok(!markdown.includes("measured (0)"), "absent historical coverage must not read as a measured zero")
  assert.match(markdown, /No typed evidence supplied|not available/i)
  assert.match(markdown, /Prior episode/)
  assert.match(markdown, /Lean classification: not supplied/)
  assert.match(markdown, /Binding mode: unbound/)
})
