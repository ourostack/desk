import { test } from "node:test"
import assert from "node:assert/strict"
import { assessConvergence } from "../../src/measurement/non-convergence.js"

function cycle(number, introduced_mechanisms) {
  return {
    cycle: number, result: "rejected", boundary: "test", open_findings: ["finding-a"], write_set: [],
    discriminator: {
      hypothesis: "same", changed_mechanism: "", expected_observation: "",
      introduced_mechanisms, repeated_boundary_reason: "", finding_categories: [],
    },
  }
}

for (const [name, legacy, current, mechanisms] of [
  ["scalar", " Helper ", ["helper"], []],
  ["architecture scalar", " Persistent_Store ", ["persistent-store"], ["persistent-store"]],
  ["null", null, [], []],
  ["empty scalar", "  ", [], []],
  ["number", 42, [], []],
  ["boolean", true, [], []],
  ["object", { registry: true }, [], []],
  ["nested array", [["registry"], null, 5], [], []],
  ["mixed array", [" Registry ", { service: true }, ["subsystem"], null], ["registry"], ["registry"]],
  ["valid array", [" helper ", "adapter", "helper"], ["adapter", "helper"], []],
  ["valid architecture array", ["service", "registry", "registry"], ["registry", "service"], ["registry", "service"]],
]) {
  test(`legacy mechanism comparison is safe and non-mutating: ${name}`, () => {
    const cycles = [cycle(1, legacy), cycle(2, current)]
    const stored = JSON.stringify(cycles)
    const result = assessConvergence({ contract: { scope_envelope: [] }, cycles })
    assert.equal(result.status, "pivot_required")
    assert.ok(result.triggers.some((entry) => entry.code === "stalled_open_findings"),
      "representational changes alone must not be new evidence of progress")
    const introduced = result.triggers.filter((entry) => entry.code === "introduced_mechanism")
    assert.deepEqual(introduced.map((entry) => [...entry.evidence.values].sort()),
      mechanisms.length ? [mechanisms, mechanisms] : [])
    assert.equal(JSON.stringify(cycles), stored)
  })
}
