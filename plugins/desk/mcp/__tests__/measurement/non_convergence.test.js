import { test } from "node:test"
import { strict as assert } from "node:assert"

import { callTool } from "../../src/server.js"
import {
  assessConvergence,
  selectPrimaryTrigger,
} from "../../src/measurement/non-convergence.js"
import { withLedger } from "../../src/measurement/store.js"
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

function discriminator(overrides = {}) {
  return {
    hypothesis: "",
    changed_mechanism: "",
    expected_observation: "",
    introduced_mechanisms: [],
    repeated_boundary_reason: "",
    finding_categories: [],
    ...overrides,
  }
}

async function prepareWorkDesignItem(fixture, request) {
  const intake = body(await ledger(fixture, { action: "intake", request }))
  const recorded = body(
    await ledger(fixture, {
      action: "run_contract",
      work_item_id: intake.work_item_id,
      phase: "implementation-phase",
      progress_signal: "The targeted boundary accepts the candidate.",
      failure_signal: "The targeted boundary rejects the candidate.",
      non_convergence_rule: "Pivot when the configured convergence controls fire.",
      scope_envelope: ["plugins/desk/mcp/src/"],
      fallback_paths: ["simplify"],
    }),
  )
  assert.equal(recorded.status, "run_contract_recorded")
  return intake.work_item_id
}

test("a ruling requires the canonical primary trigger and resolves the complete trigger cycle", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const insidePath = "plugins/desk/mcp/src/measurement/non-convergence.js"
  const outsidePath = "plugins/desk/mcp/src-other/file.js"
  const scenarios = [
    {
      name: "introduced mechanism outranks outside scope",
      cycles: [
        {
          result: "clean",
          writeSet: [outsidePath],
          discriminator: discriminator({ introduced_mechanisms: ["registry"] }),
        },
      ],
      expectedCodes: ["introduced_mechanism", "write_set_outside_scope"],
    },
    {
      name: "outside scope outranks stalled findings",
      cycles: [
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ hypothesis: "The same hypothesis." }),
        },
        {
          result: "rejected",
          writeSet: [outsidePath],
          discriminator: discriminator({ hypothesis: "The same hypothesis." }),
        },
      ],
      expectedCodes: ["write_set_outside_scope", "stalled_open_findings"],
    },
    {
      name: "stalled findings outrank three failed cycles",
      cycles: [
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-one" }),
        },
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-two" }),
        },
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-two" }),
        },
      ],
      expectedCodes: ["stalled_open_findings", "three_failed_cycles_at_boundary"],
    },
    {
      name: "three failed cycles is primary when it is the only trigger",
      cycles: [
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-one" }),
        },
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-two" }),
        },
        {
          result: "rejected",
          writeSet: [insidePath],
          discriminator: discriminator({ changed_mechanism: "candidate-three" }),
        },
      ],
      expectedCodes: ["three_failed_cycles_at_boundary"],
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const workItemId = await prepareWorkDesignItem(fixture, scenario.name)
      let pivot = null
      for (const [index, input] of scenario.cycles.entries()) {
        pivot = body(
          await ledger(fixture, {
            ...cycle(workItemId, index + 1, input.result),
            write_set: input.writeSet,
            discriminator: input.discriminator,
          }),
        )
      }

      assert.equal(pivot.status, "pivot_required")
      assert.deepEqual(
        pivot.convergence.triggers.map((entry) => entry.code),
        scenario.expectedCodes,
      )

      const primaryTrigger = scenario.expectedCodes[0]
      if (scenario.expectedCodes.length > 1) {
        const secondary = await ledger(fixture, {
          action: "work_design_ruling",
          work_item_id: workItemId,
          phase: "implementation-phase",
          cycle: scenario.cycles.length,
          trigger: scenario.expectedCodes[1],
          decision: "simplify",
          reason: "The complete trigger cycle requires one deterministic ruling.",
          evidence: "The cycle retained every convergence trigger and its evidence.",
          cost_if_wrong: "The primary label may under-emphasize another trigger.",
        })
        assert.equal(secondary.isError, true)
        assert.match(body(secondary).message, /primary trigger/iu)
      }

      const ruling = body(
        await ledger(fixture, {
          action: "work_design_ruling",
          work_item_id: workItemId,
          phase: "implementation-phase",
          cycle: scenario.cycles.length,
          trigger: primaryTrigger,
          decision: "simplify",
          reason: "The complete trigger cycle requires one deterministic ruling.",
          evidence: "The cycle retained every convergence trigger and its evidence.",
          cost_if_wrong: "The primary label may under-emphasize another trigger.",
        }),
      )
      assert.equal(ruling.status, "work_design_ruling_recorded")
      assert.equal(ruling.ruling.trigger, primaryTrigger)

      const inspected = body(
        await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
      )
      assert.deepEqual(
        inspected.cycles.at(-1).convergence_triggers,
        pivot.convergence.triggers,
      )
      assert.equal(inspected.work_design_rulings.length, 1)

      const resumed = body(
        await ledger(fixture, {
          ...cycle(workItemId, scenario.cycles.length + 1, "clean"),
          write_set: [insidePath],
          discriminator: discriminator({ changed_mechanism: "post-ruling-candidate" }),
        }),
      )
      assert.equal(resumed.status, "cycle_recorded")
      assert.deepEqual(resumed.convergence, { status: "continue", triggers: [] })
    })
  }
})

test("cycle canonicalizes discriminator values before persistence and comparison", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const workItemId = await prepareWorkDesignItem(
    fixture,
    "Canonicalize discriminator values before convergence comparison.",
  )
  const canonical = {
    hypothesis: "The same hypothesis.",
    changed_mechanism: "parser-v2",
    expected_observation: "rejected",
    introduced_mechanisms: ["adapter", "helper"],
    repeated_boundary_reason: "Same boundary.",
    finding_categories: ["correctness", "regression-risk"],
  }
  const first = body(
    await ledger(fixture, {
      ...findingCycle(workItemId, 1, {
        openFindings: ["finding-a"],
        discriminator: {
          hypothesis: "  The same hypothesis.  ",
          changed_mechanism: " parser-v2 ",
          expected_observation: " rejected ",
          introduced_mechanisms: [" helper ", "adapter", "helper"],
          repeated_boundary_reason: " Same boundary. ",
          finding_categories: [
            " Regression Risk ",
            "correctness",
            "regression_risk",
            "correctness",
          ],
        },
      }),
    }),
  )
  assert.equal(first.status, "cycle_recorded")
  assert.deepEqual(first.cycle.discriminator, canonical)

  const second = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 2, {
        openFindings: ["finding-a"],
        discriminator: {
          finding_categories: ["regression-risk", "correctness"],
          repeated_boundary_reason: "Same boundary.",
          introduced_mechanisms: ["adapter", "helper"],
          expected_observation: "rejected",
          changed_mechanism: "parser-v2",
          hypothesis: "The same hypothesis.",
        },
      }),
    ),
  )
  assert.equal(second.status, "pivot_required")
  assert.deepEqual(second.cycle.discriminator, canonical)
  assert.deepEqual(
    second.convergence.triggers.map((entry) => entry.code),
    ["stalled_open_findings"],
  )

  const inspected = body(
    await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
  )
  assert.deepEqual(
    inspected.cycles.map((entry) => entry.discriminator),
    [canonical, canonical],
  )
})

test("a canonical cycle detects stalled findings against a raw pre-hardening discriminator", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const workItemId = await prepareWorkDesignItem(
    fixture,
    "Compare a canonical discriminator with persisted pre-hardening evidence.",
  )
  const canonical = {
    hypothesis: "The same hypothesis.",
    changed_mechanism: "parser-v2",
    expected_observation: "rejected",
    introduced_mechanisms: ["adapter", "helper"],
    repeated_boundary_reason: "Same boundary.",
    finding_categories: ["correctness", "regression-risk"],
  }
  const rawLegacy = {
    hypothesis: "  The same hypothesis.  ",
    changed_mechanism: " parser-v2 ",
    expected_observation: " rejected ",
    introduced_mechanisms: [" helper ", "adapter", "helper"],
    repeated_boundary_reason: " Same boundary. ",
    finding_categories: [
      " Regression Risk ",
      "correctness",
      "regression_risk",
      "correctness",
    ],
  }
  const first = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 1, {
        openFindings: ["finding-a"],
        discriminator: canonical,
      }),
    ),
  )
  assert.equal(first.status, "cycle_recorded")

  const rawLegacyJson = JSON.stringify(rawLegacy)
  await withLedger(
    {
      deskRoot: fixture.deskRoot,
      person: "rowan",
      env: process.env,
    },
    (db) => {
      db.prepare(
        "UPDATE cycles SET discriminator = ? " +
          "WHERE work_item_id = ? AND phase = ? AND cycle = ?",
      ).run(rawLegacyJson, workItemId, "implementation-phase", 1)
    },
  )

  const second = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 2, {
        openFindings: ["finding-a"],
        discriminator: canonical,
      }),
    ),
  )
  assert.equal(second.status, "pivot_required")
  assert.deepEqual(
    second.convergence.triggers.map((entry) => entry.code),
    ["stalled_open_findings"],
  )
  assert.deepEqual(
    second.convergence.triggers[0].evidence.previous_discriminator,
    canonical,
  )

  const storedLegacyJson = await withLedger(
    {
      deskRoot: fixture.deskRoot,
      person: "rowan",
      env: process.env,
    },
    (db) =>
      db
        .prepare(
          "SELECT discriminator FROM cycles " +
            "WHERE work_item_id = ? AND phase = ? AND cycle = ?",
        )
        .get(workItemId, "implementation-phase", 1).discriminator,
  )
  assert.equal(storedLegacyJson, rawLegacyJson)
})

test("legacy scalar mechanisms compare to canonical cycles without rewriting stored history", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))
  const workItemId = await prepareWorkDesignItem(fixture, "Compare legacy scalar mechanisms safely.")
  const canonical = discriminator({ hypothesis: "Same hypothesis.", introduced_mechanisms: ["helper"] })
  assert.equal(body(await ledger(fixture, findingCycle(workItemId, 1, {
    openFindings: ["finding-a"], discriminator: canonical,
  }))).status, "cycle_recorded")
  const rawLegacyJson = JSON.stringify({ ...canonical, introduced_mechanisms: " Helper " }, null, 2)
  const options = { deskRoot: fixture.deskRoot, person: "rowan", env: process.env }
  await withLedger(options, (db) => {
    db.prepare("UPDATE cycles SET discriminator = ? WHERE work_item_id = ? AND cycle = 1")
      .run(rawLegacyJson, workItemId)
  })
  const result = await ledger(fixture, findingCycle(workItemId, 2, {
    openFindings: ["finding-a"], discriminator: canonical,
  }))
  assert.notEqual(result.isError, true, JSON.stringify(body(result)))
  assert.equal(body(result).status, "pivot_required")
  assert.deepEqual(body(result).convergence.triggers.map((entry) => entry.code), ["stalled_open_findings"])
  const stored = await withLedger(options, (db) =>
    db.prepare("SELECT discriminator FROM cycles WHERE work_item_id = ? AND cycle = 1")
      .get(workItemId).discriminator)
  assert.equal(stored, rawLegacyJson)
  assert.equal(typeof JSON.parse(stored).introduced_mechanisms, "string")
})

test("cycle refuses non-canonical discriminator shapes without storing a cycle", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const valid = discriminator({ hypothesis: "One hypothesis." })
  const { hypothesis: _omitted, ...missingHypothesis } = valid
  const cases = [
    {
      name: "unknown field",
      value: { ...valid, telemetry: "undeclared" },
    },
    {
      name: "missing field",
      value: missingHypothesis,
    },
    {
      name: "null discriminator",
      value: null,
    },
    {
      name: "null scalar",
      value: { ...valid, hypothesis: null },
    },
    {
      name: "nested scalar payload",
      value: { ...valid, hypothesis: { text: "One hypothesis." } },
    },
    {
      name: "nested list payload",
      value: { ...valid, introduced_mechanisms: [{ name: "helper" }] },
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const workItemId = await prepareWorkDesignItem(
        fixture,
        `Refuse discriminator ${testCase.name}.`,
      )
      const response = await ledger(fixture, {
        ...cycle(workItemId, 1, "clean"),
        discriminator: testCase.value,
      })
      assert.equal(response.isError, true)

      const inspected = body(
        await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
      )
      assert.equal(inspected.cycles.length, 0)
    })
  }
})

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

test("selectPrimaryTrigger returns null when no recognized trigger was reported", () => {
  assert.equal(selectPrimaryTrigger([]), null)
  assert.equal(selectPrimaryTrigger([{ code: "not-a-real-trigger" }]), null)
})

test("introduced architecture mechanisms require a pivot only for exact recognized categories", async (t) => {
  const recognizedValues = [
    "subsystem",
    "service",
    "registry",
    "persistent-store",
    "cross-platform-contract",
  ]
  const cases = [
    ...recognizedValues.map((value) => ({
      name: `${value} pivots`,
      introducedMechanisms: [value],
      expectedValues: [value],
    })),
    {
      name: "an empty list continues",
      introducedMechanisms: [],
      expectedValues: [],
    },
    {
      name: "ordinary implementation evidence continues",
      introducedMechanisms: ["helper", "refactor", "test", "adapter"],
      expectedValues: [],
    },
    {
      name: "mixed evidence returns only recognized categories in input order",
      introducedMechanisms: [
        "helper",
        "registry",
        "test",
        "cross-platform-contract",
        "service",
        "adapter",
      ],
      expectedValues: ["registry", "cross-platform-contract", "service"],
    },
    {
      name: "substring lookalikes continue",
      introducedMechanisms: [
        "subsystem-helper",
        "service-v2",
        "my-registry",
        "persistent-store-cache",
        "cross-platform-contract-test",
      ],
      expectedValues: [],
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const cycle = {
        cycle: 7,
        result: "clean",
        write_set: [],
        discriminator: {
          introduced_mechanisms: testCase.introducedMechanisms,
        },
      }
      const convergence = assessConvergence({ contract: {}, cycles: [cycle] })

      assert.deepEqual(
        convergence,
        testCase.expectedValues.length === 0
          ? { status: "continue", triggers: [] }
          : {
              status: "pivot_required",
              triggers: [
                {
                  code: "introduced_mechanism",
                  evidence: {
                    cycle: 7,
                    values: testCase.expectedValues,
                  },
                },
              ],
            },
      )
    })
  }
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

test("cycle rejects out-of-order insertions without reopening earlier evidence windows", async (t) => {
  const fixture = await mkLedgerFixture()
  t.after(() => cleanup(fixture.base))
  t.after(useHostEnv(fixture))

  const workItemId = await prepareWorkDesignItem(
    fixture,
    "Refuse out-of-order cycles while preserving post-ruling assessment windows.",
  )
  const repeatedDiscriminator = discriminator({
    hypothesis: "The parser rejects the same malformed candidate.",
  })

  const first = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 4, {
        openFindings: ["finding-a"],
        discriminator: repeatedDiscriminator,
      }),
    ),
  )
  assert.equal(first.status, "cycle_recorded")

  const outOfOrder = await ledger(
    fixture,
    findingCycle(workItemId, 2, {
      openFindings: ["finding-a"],
      discriminator: repeatedDiscriminator,
    }),
  )
  assert.equal(outOfOrder.isError, true)
  assert.match(
    body(outOfOrder).message,
    /must be greater than the latest recorded cycle/iu,
  )

  const afterRefusal = body(
    await ledger(fixture, { action: "inspect", work_item_id: workItemId }),
  )
  assert.deepEqual(
    afterRefusal.cycles.map((entry) => entry.cycle),
    [4],
  )

  const firstPivot = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 7, {
        openFindings: ["finding-a"],
        discriminator: repeatedDiscriminator,
      }),
    ),
  )
  assert.equal(firstPivot.status, "pivot_required")
  assert.deepEqual(
    firstPivot.convergence.triggers.map((entry) => entry.code),
    ["stalled_open_findings"],
  )

  const firstRuling = body(
    await ledger(fixture, {
      action: "work_design_ruling",
      work_item_id: workItemId,
      phase: "implementation-phase",
      cycle: 7,
      trigger: "stalled_open_findings",
      decision: "simplify",
      reason: "The higher-numbered retry repeated the same rejected evidence.",
      evidence: "Cycles 4 and 7 held the same open finding and discriminator.",
      cost_if_wrong: "The simplified design may omit a required parser guard.",
    }),
  )
  assert.equal(firstRuling.status, "work_design_ruling_recorded")

  const postRulingContinue = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 11, {
        openFindings: ["finding-a"],
        discriminator: repeatedDiscriminator,
      }),
    ),
  )
  assert.equal(postRulingContinue.status, "cycle_recorded")

  const postRulingPivot = body(
    await ledger(
      fixture,
      findingCycle(workItemId, 13, {
        openFindings: ["finding-a"],
        discriminator: repeatedDiscriminator,
      }),
    ),
  )
  assert.equal(postRulingPivot.status, "pivot_required")
  assert.deepEqual(
    postRulingPivot.convergence.triggers.map((entry) => entry.code),
    ["stalled_open_findings"],
  )
  assert.deepEqual(
    postRulingPivot.convergence.triggers[0].evidence.cycles.map((entry) => entry.cycle),
    [11, 13],
  )
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
