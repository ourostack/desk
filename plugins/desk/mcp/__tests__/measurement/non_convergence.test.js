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

function findingCycle(workItemId, cycleNumber, { openFindings, discriminator }) {
  return {
    ...cycle(workItemId, cycleNumber, "rejected"),
    open_findings: openFindings,
    discriminator,
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

test("scope envelope admits exact files and slash-terminated directories", async (t) => {
  const cases = [
    {
      name: "exact file admitted",
      scopeEnvelope: ["src/file.js"],
      writeSet: ["src/file.js"],
      expected: { status: "continue", triggers: [] },
    },
    {
      name: "file mismatch pivots",
      scopeEnvelope: ["src/file.js"],
      writeSet: ["src/file.js.map"],
      outsidePaths: ["src/file.js.map"],
    },
    {
      name: "directory descendant admitted",
      scopeEnvelope: ["src/"],
      writeSet: ["src/nested/file.js"],
      expected: { status: "continue", triggers: [] },
    },
    {
      name: "sibling-prefix path pivots",
      scopeEnvelope: ["src/"],
      writeSet: ["src-other/file.js"],
      outsidePaths: ["src-other/file.js"],
    },
    {
      name: "mixed write set returns only outside paths",
      scopeEnvelope: ["src/", "README.md"],
      writeSet: ["src/file.js", "README.md", "src-other/file.js", "docs/notes.md"],
      outsidePaths: ["src-other/file.js", "docs/notes.md"],
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const convergence = assessConvergence({
        contract: { scope_envelope: testCase.scopeEnvelope },
        cycles: [{ cycle: 7, result: "clean", write_set: testCase.writeSet }],
      })

      assert.deepEqual(
        convergence,
        testCase.expected ?? {
          status: "pivot_required",
          triggers: [
            {
              code: "write_set_outside_scope",
              evidence: {
                cycle: 7,
                paths: testCase.outsidePaths,
                scope_envelope: testCase.scopeEnvelope,
              },
            },
          ],
        },
      )
    })
  }
})

test("a Desk client pivots only when rejected cycles stall without a new discriminator", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const emptyDiscriminator = {
    hypothesis: "",
    changed_mechanism: "",
    expected_observation: "",
    introduced_mechanisms: [],
    repeated_boundary_reason: "",
    finding_categories: [],
  }
  const repeatedDiscriminator = {
    ...emptyDiscriminator,
    hypothesis: "The parser rejects the same malformed candidate.",
  }
  const cases = [
    {
      name: "stable finding count with no new discriminator pivots",
      previousOpenFindings: ["finding-a"],
      currentOpenFindings: ["finding-a"],
      previousDiscriminator: emptyDiscriminator,
      currentDiscriminator: emptyDiscriminator,
      expectedStatus: "pivot_required",
    },
    {
      name: "shrinking findings continue",
      previousOpenFindings: ["finding-a", "finding-b"],
      currentOpenFindings: ["finding-a"],
      previousDiscriminator: emptyDiscriminator,
      currentDiscriminator: emptyDiscriminator,
      expectedStatus: "continue",
    },
    {
      name: "a new discriminator continues",
      previousOpenFindings: ["finding-a"],
      currentOpenFindings: ["finding-a"],
      previousDiscriminator: emptyDiscriminator,
      currentDiscriminator: {
        ...emptyDiscriminator,
        changed_mechanism: "The parser now rejects duplicate keys before validation.",
      },
      expectedStatus: "continue",
    },
    {
      name: "a repeated identical discriminator pivots",
      previousOpenFindings: ["finding-a"],
      currentOpenFindings: ["finding-a"],
      previousDiscriminator: repeatedDiscriminator,
      currentDiscriminator: repeatedDiscriminator,
      expectedStatus: "pivot_required",
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const intake = body(
        await ledger(fixture, {
          action: "intake",
          request: `Assess finding movement: ${testCase.name}.`,
        }),
      )
      const workItemId = intake.work_item_id
      const contract = body(
        await ledger(fixture, {
          action: "run_contract",
          work_item_id: workItemId,
          phase: "implementation-phase",
          progress_signal: "Open findings shrink or a new discriminator is recorded.",
          failure_signal: "Open findings stall without a new discriminator.",
          non_convergence_rule: "Pivot when rejected cycles stall without new learning.",
          scope_envelope: ["plugins/desk/mcp/src/"],
          fallback_paths: ["simplify"],
        }),
      )
      assert.equal(contract.status, "run_contract_recorded")

      const previous = body(
        await ledger(
          fixture,
          findingCycle(workItemId, 1, {
            openFindings: testCase.previousOpenFindings,
            discriminator: testCase.previousDiscriminator,
          }),
        ),
      )
      assert.equal(previous.status, "cycle_recorded")
      assert.equal(previous.convergence.status, "continue")

      const current = body(
        await ledger(
          fixture,
          findingCycle(workItemId, 2, {
            openFindings: testCase.currentOpenFindings,
            discriminator: testCase.currentDiscriminator,
          }),
        ),
      )
      assert.equal(
        current.status,
        testCase.expectedStatus === "continue" ? "cycle_recorded" : "pivot_required",
      )
      assert.equal(current.convergence.status, testCase.expectedStatus)

      if (testCase.expectedStatus === "continue") {
        assert.deepEqual(current.convergence.triggers, [])
        return
      }

      assert.equal(current.convergence.triggers.length, 1)
      const trigger = current.convergence.triggers[0]
      assert.equal(trigger.code, "stalled_open_findings")
      assert.deepEqual(Object.keys(trigger.evidence).sort(), [
        "current_discriminator",
        "current_open_findings",
        "cycles",
        "previous_discriminator",
        "previous_open_findings",
      ])
      assert.deepEqual(
        trigger.evidence.cycles.map((entry) => entry.cycle),
        [1, 2],
      )
      assert.deepEqual(
        trigger.evidence.previous_open_findings,
        testCase.previousOpenFindings,
      )
      assert.deepEqual(trigger.evidence.current_open_findings, testCase.currentOpenFindings)
      assert.deepEqual(
        trigger.evidence.previous_discriminator,
        testCase.previousDiscriminator,
      )
      assert.deepEqual(trigger.evidence.current_discriminator, testCase.currentDiscriminator)
    })
  }
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
