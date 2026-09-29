import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { alphaDatasets } from "../dataset-registry.mjs";
import { main } from "../cli.mjs";
import { jsonBytes, sha256 } from "../core.mjs";
import { expectedFixture, planFixture } from "./helpers/run-set.mjs";
import { workRoot } from "./helpers/paths.mjs";
import { buildCheckerPreflight, discussionThenGoDefinition, discussionThenGoInput, generousLimits, identity, installCheckerTransport, seedBaseCommit, unscriptedInput } from "./helpers/v2-native-campaign.mjs";

const models = ["gpt-6-astra", "claude-opus-5"];

// This is the same proof issue #56 requires of the documented operator path: a real plan naming
// `engineering-v2-alpha-v2`, run through the actual, unmodified `offline run` CLI command (`cli.mjs`'s exported
// `main`, the same function `scripts/skill-evals.cjs offline run` calls), using the fixture/actor mode this
// environment's fixed controller supports natively in place of a live model session. The campaign genuinely passes
// both configuration strata of the dataset's first case and then honestly holds at the next case, which has no
// mapped native Git seed -- no cell result anywhere in this test is fabricated or hidden.
test("a native run of engineering-v2-alpha-v2 through the real CLI passes its first case and honestly holds at the next unseeded one", async t => {
  const restoreCheckerTransport = installCheckerTransport();
  t.after(restoreCheckerTransport);
  const root = workRoot("v2-native-campaign");
  const { dataset, sourceRoot } = alphaDatasets["engineering-v2-alpha-v2"];
  const datasetBytes = fs.readFileSync(path.join(sourceRoot, "dataset.json"));
  const fixtureManifestBytes = fs.readFileSync(path.join(sourceRoot, "fixture-manifest.json"));
  const checkerManifestBytes = fs.readFileSync(path.join(sourceRoot, "check-expectations.json"));

  const plan = planFixture("v2-native-campaign");
  plan.limits = structuredClone(generousLimits);
  plan.dataset = { id: dataset.id, version: dataset.version, sha256: sha256(datasetBytes) };
  plan.fixtureManifestSha256 = sha256(fixtureManifestBytes);
  plan.checkerManifestSha256 = sha256(checkerManifestBytes);

  const expected = { schemaVersion: 1, cells: dataset.cases.flatMap(definition => models.map((model, index) => {
    const cell = expectedFixture(plan, false).cells[0];
    cell.id = `${definition.id}-${index + 1}`;
    cell.caseId = definition.id;
    cell.subject.model = model;
    cell.judge.model = model;
    return cell;
  })) };
  assert.equal(expected.cells.length, 10);

  const inputRoot = path.join(root, "input");
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, "expected-cells.json"), jsonBytes(expected));
  plan.expectedCells = { path: "expected-cells.json", sha256: sha256(jsonBytes(expected)) };

  const definition = discussionThenGoDefinition();
  const baseCommit = await seedBaseCommit(path.join(root, "seed"));
  const seedFor = cellId => ({ cellId, fixtureId: definition.fixture, subjectFilesManifestSha256: sha256("synthetic seed manifest"), baseCommit, initialBranch: "fixture", identity, seedReceipt: { path: "seed.json", sha256: sha256("synthetic seed receipt") } });
  plan.gitSeeds = [seedFor("discussion-then-go-1"), seedFor("discussion-then-go-2")];
  fs.writeFileSync(path.join(inputRoot, "plan.json"), jsonBytes(plan));

  const cells = new Map();
  for (const [index, model] of models.entries()) cells.set(`discussion-then-go-${index + 1}`, discussionThenGoInput({ root: path.join(root, `cell-discussion-then-go-${index + 1}`), model }));
  for (const value of dataset.cases) {
    if (value.id === "discussion-then-go") continue;
    for (const index of [0, 1]) cells.set(`${value.id}-${index + 1}`, unscriptedInput());
  }
  const checker = buildCheckerPreflight(path.join(root, "checker"));
  const nativeInputs = { assertAllocation: async () => {}, assertSourceAndRuntime: async () => {}, cells, checker };

  let output = "";
  const io = { stdout: { write: text => { output += text; } } };
  const outputRoot = path.join(root, "run");
  const result = await main(["run", "--plan", path.join(inputRoot, "plan.json"), "--output", outputRoot], io, nativeInputs);
  const report = JSON.parse(output);
  const caseList = expected.cells.map(cell => cell.caseId);
  console.log(`engineering-v2-alpha-v2 native campaign report: ${JSON.stringify({ status: report.status, attempts: report.attempts, caseList, attemptStatuses: report.attemptStatuses })}`);

  assert.equal(result, 3);
  assert.equal(report.attempts, 3);
  assert.equal(report.attemptStatuses[0].cellId, "discussion-then-go-1");
  assert.equal(report.attemptStatuses[0].status, "passed");
  assert.equal(report.attemptStatuses[1].cellId, "discussion-then-go-2");
  assert.equal(report.attemptStatuses[1].status, "passed");
  assert.equal(report.attemptStatuses[2].status, "unavailable");
  assert.deepEqual(caseList, dataset.cases.flatMap(value => models.map(() => value.id)));
  const runSet = JSON.parse(fs.readFileSync(path.join(outputRoot, "run-set.json")));
  assert.equal(runSet.unstartedCellIds.length, 7);
});
