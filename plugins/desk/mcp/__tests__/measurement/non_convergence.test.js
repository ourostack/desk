import { test } from "node:test"
import { strict as assert } from "node:assert"

import { callTool } from "../../src/server.js"
import { assessConvergence } from "../../src/measurement/non-convergence.js"
import { cleanup, mkLedgerFixture, useHostEnv } from "./_helpers.js"

function body(result) {
  return JSON.parse(result.content[0].text)
}

async function ledger(fixture, input) {
  return callTool({
    deskRoot: fixture.deskRoot,
    name: "desk_work_ledger",
    input,
    person: "rowan",
  })
}

function cycle(workItemId, cycleNumber, result) {
  return {
    action: "cycle",
    work_item_id: workItemId,
    phase: "implementation-phase",
    cycle: cycleNumber,
    candidate_ref: `candidate-${cycleNumber}`,
    boundary: " Targeted Test ",
    result,
    progress_evidence:
      result === "clean"
        ? "The simplified candidate passes the targeted boundary."
        : "The targeted boundary rejected the candidate.",
    finding_fingerprint: `sha256:${String(cycleNumber).padStart(64, "0")}`,
    open_findings: result === "clean" ? [] : ["finding-a"],
    closed_findings: result === "clean" ? ["finding-a"] : [],
    write_set: [
      " plugins/desk/mcp/src/tools/work-ledger.js ",
      "plugins/desk/mcp/src/tools/work-ledger.js",
    ],
    discriminator: {
      hypothesis: `Candidate ${cycleNumber} tests the same boundary.`,
      changed_mechanism: `candidate-${cycleNumber}`,
      expected_observation: result,
      introduced_mechanisms: [],
      repeated_boundary_reason: "",
      finding_categories: ["correctness"],
    },
  }
}

test("only rejected cycle results count toward the three-cycle pivot", () => {
  const convergence = assessConvergence({
    contract: {},
    cycles: [
      { cycle: 1, boundary: "targeted-test", result: "unavailable" },
      { cycle: 2, boundary: "targeted-test", result: "cancelled" },
      { cycle: 3, boundary: "targeted-test", result: "contradictory" },
    ],
  })

  assert.deepEqual(convergence, { status: "continue", triggers: [] })
})

test("a Desk client pivots after three rejected boundary cycles and resumes after a ruling", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const intake = body(
    await ledger(fixture, {
      action: "intake",
      request: "Deliver one assessable work-design outcome.",
    }),
  )
  assert.equal(intake.status, "intake_recorded")
  const workItemId = intake.work_item_id

  const contract = body(
    await ledger(fixture, {
      action: "run_contract",
      work_item_id: workItemId,
      phase: " Implementation Phase ",
      progress_signal: "The targeted boundary accepts the candidate.",
      failure_signal: "The targeted boundary rejects the candidate.",
      non_convergence_rule: "Pivot after three failed cycles at one boundary.",
      scope_envelope: [
        " plugins/desk/mcp/src/ ",
        "plugins/desk/mcp/src/tools/work-ledger.js",
        "plugins/desk/mcp/src/",
      ],
      fallback_paths: ["revert", "simplify", "revert"],
    }),
  )
  assert.equal(contract.status, "run_contract_recorded", contract.message ?? "")
  assert.equal(contract.run_contract.phase, "implementation-phase")
  assert.deepEqual(contract.run_contract.scope_envelope, [
    "plugins/desk/mcp/src/",
    "plugins/desk/mcp/src/tools/work-ledger.js",
  ])
  assert.deepEqual(contract.run_contract.fallback_paths, ["simplify", "revert"])

  for (const cycleNumber of [1, 2]) {
    const recorded = body(await ledger(fixture, cycle(workItemId, cycleNumber, "rejected")))
    assert.equal(recorded.status, "cycle_recorded")
    assert.equal(recorded.convergence.status, "continue")
    assert.equal(recorded.cycle.boundary, "targeted-test")
    assert.deepEqual(recorded.cycle.write_set, [
      "plugins/desk/mcp/src/tools/work-ledger.js",
    ])
  }

  const pivot = body(await ledger(fixture, cycle(workItemId, 3, "rejected")))
  assert.equal(pivot.status, "pivot_required")
  assert.equal(pivot.cycle.cycle, 3)
  assert.deepEqual(pivot.convergence, {
    status: "pivot_required",
    triggers: [
      {
        code: "three_failed_cycles_at_boundary",
        evidence: {
          boundary: "targeted-test",
          cycles: [1, 2, 3],
          results: ["rejected", "rejected", "rejected"],
        },
      },
    ],
  })

  const fourth = await ledger(fixture, cycle(workItemId, 4, "rejected"))
  assert.equal(fourth.isError, true)
  assert.match(body(fourth).message, /unresolved pivot/iu)

  const ruling = body(
    await ledger(fixture, {
      action: "work_design_ruling",
      work_item_id: workItemId,
      phase: " Implementation Phase ",
      cycle: 3,
      trigger: "three_failed_cycles_at_boundary",
      decision: "simplify",
      reason: "Three corrections did not change the boundary result.",
      evidence: "Cycles 1, 2, and 3 were rejected at targeted-test.",
      cost_if_wrong: "The simplified design may omit a required guard.",
    }),
  )
  assert.equal(ruling.status, "work_design_ruling_recorded")
  assert.deepEqual(
    {
      phase: ruling.ruling.phase,
      cycle: ruling.ruling.cycle,
      trigger: ruling.ruling.trigger,
      decision: ruling.ruling.decision,
      reason: ruling.ruling.reason,
      evidence: ruling.ruling.evidence,
      cost_if_wrong: ruling.ruling.cost_if_wrong,
    },
    {
      phase: "implementation-phase",
      cycle: 3,
      trigger: "three_failed_cycles_at_boundary",
      decision: "simplify",
      reason: "Three corrections did not change the boundary result.",
      evidence: "Cycles 1, 2, and 3 were rejected at targeted-test.",
      cost_if_wrong: "The simplified design may omit a required guard.",
    },
  )

  const resumed = body(await ledger(fixture, cycle(workItemId, 4, "clean")))
  assert.equal(resumed.status, "cycle_recorded")
  assert.equal(resumed.convergence.status, "continue")
  assert.deepEqual(resumed.convergence.triggers, [])

  const inspected = body(
    await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
  )
  assert.equal(inspected.run_contracts.length, 1)
  assert.equal(inspected.cycles.length, 4)
  assert.equal(inspected.cycles[2].convergence_status, "pivot_required")
  assert.deepEqual(inspected.cycles[2].convergence_triggers, pivot.convergence.triggers)
  assert.equal(inspected.work_design_rulings.length, 1)

  const deleted = body(
    await ledger(fixture, { action: "delete", work_item_id: workItemId, confirm: true }),
  )
  for (const table of ["run_contracts", "cycles", "work_design_rulings"]) {
    assert.ok(deleted.removed_rows.some((entry) => entry.table === table), table)
  }
})

test("cycle accepts a digit-only decimal string and returns its normalized integer", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const intake = body(
    await ledger(fixture, {
      action: "intake",
      request: "Record one string-numbered cycle.",
    }),
  )
  const workItemId = intake.work_item_id

  const contract = body(
    await ledger(fixture, {
      action: "run_contract",
      work_item_id: workItemId,
      phase: "implementation-phase",
      progress_signal: "The boundary accepts the candidate.",
      failure_signal: "The boundary rejects the candidate.",
      non_convergence_rule: "Pivot after three rejected cycles at one boundary.",
      scope_envelope: ["plugins/desk/mcp/src/"],
      fallback_paths: ["simplify"],
    }),
  )
  assert.equal(contract.status, "run_contract_recorded")

  const recorded = body(await ledger(fixture, cycle(workItemId, "3", "rejected")))
  assert.equal(recorded.status, "cycle_recorded", recorded.message ?? "")
  assert.equal(recorded.cycle.cycle, 3)
})

test("cycle refuses unsafe integer representations before storing them", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const outcomes = []
  for (const [representation, unsafeCycle] of [
    ["number", Number.MAX_SAFE_INTEGER + 1],
    ["decimal string", "9007199254740993"],
  ]) {
    const intake = body(
      await ledger(fixture, {
        action: "intake",
        request: `Refuse one unsafe cycle ${representation}.`,
      }),
    )
    const workItemId = intake.work_item_id

    const contract = body(
      await ledger(fixture, {
        action: "run_contract",
        work_item_id: workItemId,
        phase: "implementation-phase",
        progress_signal: "The boundary accepts the candidate.",
        failure_signal: "The boundary rejects the candidate.",
        non_convergence_rule: "Pivot after three rejected cycles at one boundary.",
        scope_envelope: ["plugins/desk/mcp/src/"],
        fallback_paths: ["simplify"],
      }),
    )
    assert.equal(contract.status, "run_contract_recorded")

    const response = await ledger(fixture, cycle(workItemId, unsafeCycle, "rejected"))
    const inspected = body(
      await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
    )
    outcomes.push({
      representation,
      refused: response.isError === true,
      stored_cycles: inspected.cycles.length,
    })
  }

  assert.deepEqual(outcomes, [
    { representation: "number", refused: true, stored_cycles: 0 },
    { representation: "decimal string", refused: true, stored_cycles: 0 },
  ])
})
