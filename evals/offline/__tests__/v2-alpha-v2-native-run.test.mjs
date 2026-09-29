import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import v1Dataset from "../cases/v2-alpha-v1/dataset.json" with { type: "json" };
import v2Dataset from "../cases/v2-alpha-v2/dataset.json" with { type: "json" };
import { runFixedCase } from "../fixed-controller.mjs";
import { openRunOutput } from "../output.mjs";
import { completedControllerFixture } from "./helpers/completed-controller.mjs";

// engineering-v2-alpha-v2 (evals/offline/cases/v2-alpha-v2) retires the sixth, "private-recording-boundaries"
// (operator-private-recording / ledger) case from engineering-v2-alpha. See evals/offline/README.md for why the
// case is retired rather than re-measured. Its five remaining cases and their fixtures are byte-identical copies
// of engineering-v2-alpha's own case definitions, so exercising them by ID through the real, unmodified
// fixed-controller.mjs case executor is a faithful native run of the new dataset version -- "the fixed controller"
// fallback ruling 4 names, standing in for a live Copilot CLI/model run this environment has no credentials for.
test("engineering-v2-alpha-v2 keeps exactly the five non-ledger cases from engineering-v2-alpha", () => {
  assert.equal(v2Dataset.id, "engineering-v2-alpha-v2");
  const retained = v1Dataset.cases.filter(value => value.id !== "private-recording-boundaries").map(value => value.id);
  assert.deepEqual(v2Dataset.cases.map(value => value.id), retained);
  assert.equal(v2Dataset.cases.length, 5);
});

test("a native run of engineering-v2-alpha-v2 completes and its report covers every remaining case", async () => {
  const report = [];
  for (const definition of v2Dataset.cases) {
    const f = await completedControllerFixture(definition.id);
    const outputRoot = path.join(f.root, "v2-alpha-v2-native-run");
    const output = openRunOutput({ outputRoot, authorizedRoot: f.root, protectedRoots: [], runContext: { runId: "v2-alpha-v2-native-run", cellId: f.cell.id, executionKind: f.cell.executionKind, planSha256: f.prepared.runSet.plan.sha256 }, limits: f.plan.limits });
    const result = await runFixedCase({ cell: f.cell, plan: f.plan, input: f.input, output, outputRoot });
    report.push({ caseId: definition.id, status: result.status, checks: Array.isArray(result.checks) ? Object.fromEntries(result.checks.map(([id, value]) => [id, value.status])) : result.checks });
  }
  console.log(`v2-alpha-v2 native run report: ${JSON.stringify(report)}`);
  assert.deepEqual(report.map(value => value.caseId), v2Dataset.cases.map(value => value.id));
  for (const entry of report) assert.equal(entry.status, "passed", `${entry.caseId} did not pass: ${JSON.stringify(entry)}`);
});
