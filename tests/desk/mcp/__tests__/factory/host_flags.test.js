import { test } from "node:test"
import assert from "node:assert/strict"

import { HOST_FLAGS, hostFlagsFor } from "../../../../../plugins/desk/mcp/src/factory/host-flags.js"

test("hostFlagsFor returns each host's constant flags and nothing for an unknown host", () => {
  for (const host of ["claude-code", "codex-cli", "copilot-cli"]) {
    assert.deepEqual(hostFlagsFor(host, { entrypoint: "desktop" }), HOST_FLAGS[host])
  }
  assert.deepEqual(hostFlagsFor("claude-code", { entrypoint: "cli" }), [
    { field: "compaction_waits", reason: "host_does_not_record" },
    { field: "reasoning_tokens", reason: "host_does_not_record" },
    { field: "commits", reason: "host_does_not_record" },
    { field: "permission_waits", reason: "host_does_not_record" },
    { field: "prs", reason: "host_records_partly" },
    { field: "api_retries", reason: "host_records_partly" },
  ])
  assert.deepEqual(hostFlagsFor("codex-cli", {}).map((flag) => `${flag.field}/${flag.reason}`), [
    "compaction_waits/host_does_not_record",
    "commits/host_does_not_record",
    "permission_waits/host_does_not_record",
    "api_retries/host_does_not_record",
    "prs/host_records_partly",
    "tool_outcomes/host_records_partly",
    "requests/host_records_partly",
    "tokens/host_records_partly",
    "human_turns/host_does_not_record",
  ])
  assert.deepEqual(hostFlagsFor("nonesuch", { entrypoint: "cli" }), [])
  assert.deepEqual(hostFlagsFor(undefined), [])
  assert.deepEqual(hostFlagsFor(null, null), [])
  assert.deepEqual(hostFlagsFor("constructor", {}), [])
  assert.deepEqual(hostFlagsFor("__proto__", {}), [])
})

test("hostFlagsFor adds the entrypoint flag for Copilot cli sessions only", () => {
  assert.deepEqual(hostFlagsFor("copilot-cli", { entrypoint: "cli" }), [
    { field: "prs", reason: "host_records_partly" },
    { field: "human_turns", reason: "host_records_partly" },
    { field: "entrypoint", reason: "host_does_not_record" },
  ])
  assert.deepEqual(hostFlagsFor("copilot-cli", { entrypoint: "desktop" }), [{ field: "prs", reason: "host_records_partly" }, { field: "human_turns", reason: "host_records_partly" }])
  assert.deepEqual(hostFlagsFor("copilot-cli"), [{ field: "prs", reason: "host_records_partly" }, { field: "human_turns", reason: "host_records_partly" }])
  assert.equal(hostFlagsFor("claude-code", { entrypoint: "cli" }).some((flag) => flag.field === "entrypoint"), false)
  assert.equal(hostFlagsFor("codex-cli", { entrypoint: "cli" }).some((flag) => flag.field === "entrypoint"), false)
})

test("hostFlagsFor returns copies so a caller cannot change the table", () => {
  hostFlagsFor("claude-code", {}).push({ field: "tokens", reason: "field_absent" })
  hostFlagsFor("claude-code", {})[0].reason = "log_missing"
  assert.equal(HOST_FLAGS["claude-code"].length, 6)
  assert.equal(HOST_FLAGS["claude-code"][0].reason, "host_does_not_record")
  assert.throws(() => HOST_FLAGS["claude-code"].push({}), TypeError)
})
