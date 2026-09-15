import { test } from "node:test"
import { strict as assert } from "node:assert"
import { buildWorkProfile } from "../../src/measurement/work-profile.js"

test("non-interaction native sequence ties remain deterministic and operation IDs are agent-scoped", () => {
  function fact(id, kind, agent, call, second, extra = {}) {
    return {
      fact_id: id, kind, agent_id: agent, native_session_id: "session-a",
      timestamp: `2026-01-01T00:00:0${second}Z`,
      source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: id, line: 1 },
      fields: { toolCallId: call }, ...extra,
    }
  }
  const input = {
    schema_version: 1,
    binding: { native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a", title: "Synthetic sequence ties", work_item_id: null, task_ref: null },
    facts: [
      fact("dispatch", "tool.execution_start", null, "dispatch-a", 0),
      fact("started", "subagent.started", "worker-a", "dispatch-a", 1),
      fact("returned", "tool.execution_complete", null, "dispatch-a", 2, { returned_agent_id: "worker-a" }),
      fact("child", "subagent.started", "worker-b", "dispatch-b", 3, { structural_parent_agent_id: "worker-a" }),
      fact("a-start", "tool.execution_start", "worker-a", "reused-id", 4),
      fact("a-end", "tool.execution_complete", "worker-a", "reused-id", 5),
      fact("b-start", "tool.execution_start", "worker-b", "reused-id", 4),
      fact("b-end", "tool.execution_complete", "worker-b", "reused-id", 6),
    ],
  }
  const first = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  input.facts.reverse()
  const second = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  assert.equal(first.observations.operations.tool.matched, 2)
  assert.equal(first.observations.operations.tool.summed_latency_ms, 3000)
  assert.equal(first.observations.operations.tool.interval_union_ms, 2000)
  delete first.source_snapshot_sha256
  delete second.source_snapshot_sha256
  assert.deepEqual(first, second)
})

test("typed evidence and Lean annotations are deterministic regardless of their declared input order", () => {
  const input = {
    schema_version: 1,
    binding: { native_session_id: "session-a", root_agent_id: "worker-a", dispatch_tool_call_id: "dispatch-a", title: "Synthetic evidence order", work_item_id: null, task_ref: null },
    facts: [
      { fact_id: "dispatch", kind: "tool.execution_start", agent_id: null, native_session_id: "session-a", timestamp: "2026-01-01T00:00:00Z", source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: "dispatch" }, fields: { toolCallId: "dispatch-a" } },
      { fact_id: "started", kind: "subagent.started", agent_id: "worker-a", native_session_id: "session-a", timestamp: "2026-01-01T00:00:01Z", source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: "started" }, fields: { toolCallId: "dispatch-a" } },
      { fact_id: "returned", kind: "tool.execution_complete", agent_id: null, native_session_id: "session-a", timestamp: "2026-01-01T00:00:02Z", source_ref: { source_id: "events-a", native_session_id: "session-a", event_id: "returned" }, fields: { toolCallId: "dispatch-a" }, returned_agent_id: "worker-a" },
    ],
    evidence: [
      { evidence_id: "b-state", role: "source_system", claim_type: "mutable_state", class: "measured", producer: "source_native", observed_at: "2026-01-01T00:00:01Z", refs: [], fact_ids: [] },
      { evidence_id: "a-intent", role: "desk", claim_type: "intent", class: "declared", producer: "agent_annotation", observed_at: "2026-01-01T00:00:00Z", refs: [], fact_ids: [] },
    ],
  }
  const first = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  input.evidence.reverse()
  const second = buildWorkProfile(Buffer.from(JSON.stringify(input)))
  delete first.source_snapshot_sha256
  delete second.source_snapshot_sha256
  assert.deepEqual(first, second)
  assert.deepEqual(first.evidence.map((e) => e.evidence_id), ["a-intent", "b-state"])
})
