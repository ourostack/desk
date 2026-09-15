import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareScoredResults, replayScoredCell } from "../scored-comparison.mjs";
import { runFixedCase } from "../fixed-controller.mjs";
import * as fixedController from "../fixed-controller.mjs";
import { openRunOutput } from "../output.mjs";
import { jsonBytes, sha256 } from "../core.mjs";
import { controllerFixture } from "./helpers/controller-fixture.mjs";
import { privateControllerFixture } from "./helpers/private-controller.mjs";

let sequence = 0;
async function produce(deterministic = false) {
  const f = deterministic ? await privateControllerFixture() : await controllerFixture("checker-is-enforced", { send: ({ roles }) => {
    const filename = path.join(roles.actor, "package.json");
    const value = JSON.parse(fs.readFileSync(filename));
    value.scripts.ci = "npm run test && npm run check";
    fs.writeFileSync(filename, JSON.stringify(value));
  } });
  const outputRoot = path.join(f.root, "produced");
  const context = { runId: "comparison-source-control", cellId: f.cell.id, executionKind: f.cell.executionKind, planSha256: f.prepared.runSet.plan.sha256 };
  const output = openRunOutput({ outputRoot, authorizedRoot: f.root, protectedRoots: [], runContext: context, limits: f.plan.limits });
  const result = await runFixedCase({ cell: f.cell, plan: f.plan, input: f.input, output, outputRoot, bindingAdmitted: true });
  assert.equal(result.status, "passed");
  const files = new Map(fs.readdirSync(outputRoot).map(name => [name, fs.readFileSync(path.join(outputRoot, name))]));
  const receipt = { ...context, schemaVersion: 1, ...result, caseId: f.cell.caseId };
  function publication(change = () => {}) {
    const root = path.join(f.root, `replay-${++sequence}`);
    const artifacts = new Map(files);
    const value = structuredClone(receipt);
    change(artifacts, value);
    const out = openRunOutput({ outputRoot: root, authorizedRoot: f.root, protectedRoots: [], runContext: context, limits: f.plan.limits });
    for (const [name, bytes] of artifacts) {
      if (name === "receipt.incomplete.json") continue;
      if (name === "stdout.raw" || name === "stderr.raw") out.appendRaw(name.slice(0, -4), bytes);
      else out.writeArtifact(name, bytes);
    }
    out.commit(value);
    const cell = { cellId: f.cell.id, commitMarker: { path: `${path.basename(root)}/COMMITTED.json`, sha256: sha256(fs.readFileSync(path.join(root, "COMMITTED.json"))) }, receipt: { path: `${path.basename(root)}/receipt.json`, sha256: sha256(fs.readFileSync(path.join(root, "receipt.json"))) } };
    return { root: f.root, cell, expected: f.cell };
  }
  return { publication };
}
const edit = (files, name, change) => {
  const value = JSON.parse(files.get(name));
  change(value);
  files.set(name, jsonBytes(value));
};
test("comparison replays native grading evidence and refuses altered rubrics, models, streams and counts", async () => {
  const f = await produce();
  assert.equal(replayScoredCell(f.publication()).status, "passed");
  for (const [change, code] of [
    [(files, receipt) => { receipt.status = "unavailable"; receipt.grade = null; receipt.counts.admittedGrades = 0; }, "CELL_UNSCORED"],
    [files => { files.delete([...files.keys()].find(name => name.endsWith("-valid-still-green-observation.json"))); }, "CHECK_EVIDENCE_MISSING"],
    [files => { const name = [...files.keys()].find(name => name.endsWith("-valid-still-green-observation.json")); edit(files, name, value => { value.availability = "unavailable"; }); }, "CHECK_EVIDENCE_UNAVAILABLE"],
    [files => edit(files, "controller-assessment.json", value => { value.caseId = "other"; }), "ASSESSMENT_RUBRIC_MISMATCH"],
    [files => edit(files, "controller-assessment.json", value => { value.criteria = []; }), "ASSESSMENT_RUBRIC_MISMATCH"],
    [files => edit(files, "controller-assessment.json", value => { value.fixedVerdicts = []; }), "ASSESSMENT_RUBRIC_MISMATCH"],
    [files => edit(files, "controller-judge-plan.json", value => { value.model = "claude-opus-5"; }), "ASSESSMENT_MODEL_MISMATCH"],
    [files => { files.set("controller-judge.stdout", files.get("controller-judge.stdout").subarray(0, -1)); }, "ASSESSMENT_CAPTURE_INCOMPLETE"],
    [(files, receipt) => { receipt.grade.summary = "not the actual native report"; }, "ASSESSMENT_RESULT_MISMATCH"],
    [(files, receipt) => { receipt.status = "product_failure"; }, "OUTPUT_WRITE_FAILED"],
    [(files, receipt) => { receipt.counts.observedRequests++; }, "ASSESSMENT_RESULT_MISMATCH"],
  ]) assert.throws(() => replayScoredCell(f.publication(change)), { code });
  const missingCase = f.publication();
  missingCase.expected = { ...missingCase.expected, caseId: "absent" };
  assert.throws(() => replayScoredCell(missingCase), { code: "CELL_UNSCORED" });
  const unpublished = f.publication();
  unpublished.cell.receipt = null;
  assert.throws(() => replayScoredCell(unpublished), { code: "CELL_UNPUBLISHED" });
  const side = value => ({ root: value.root, inventoryComplete: true, expectedCells: { cells: [value.expected] }, cells: [value.cell] });
  const left = side(f.publication());
  const right = side(f.publication());
  const result = compareScoredResults({ left, right, compatibility: { compatible: true } });
  assert.equal(result.scored, true);
  assert.equal(result.missing, 0);
  assert.equal(result.grade, null);
  for (const sides of [{ left: { ...left, inventoryComplete: false }, right }, { left, right: { ...right, inventoryComplete: false } }, { left, right: { ...right, cells: [] } }]) assert.equal(compareScoredResults({ ...sides, compatibility: { compatible: true } }).scored, false);
});
test("deterministic cells replay their exact observations with null grades and a full missing denominator", async () => {
  const f = await produce(true);
  assert.deepEqual(replayScoredCell(f.publication()), { status: "passed", grade: null, executionKind: "deterministic" });
  const failing = f.publication((files, receipt) => {
    const name = [...files.keys()].find(name => name.endsWith("-protected-own-work-observation.json"));
    edit(files, name, value => { value.visibility = "not-private"; });
    receipt.status = "product_failure";
  });
  assert.equal(replayScoredCell(failing).status, "product_failure");
  assert.throws(() => replayScoredCell(f.publication((files, receipt) => { receipt.status = "product_failure"; })), { code: "DETERMINISTIC_RESULT_MISMATCH" });
  assert.throws(() => f.publication((files, receipt) => { receipt.grade = { status: "pass" }; }), { code: "OUTPUT_WRITE_FAILED" });
});

const skillEvals = (await import(new URL("../../../scripts/skill-evals.cjs", import.meta.url))).default;
const { revisionPublication } = fixedController;
const controlled = (head, change = () => {}) => {
  const plan = {
    candidate: { repository: "owner/approved-repository", sourceCommit: head },
    comparison: { groupId: "alpha-group", policySha256: "7".repeat(64) },
    dataset: { id: "engineering-v2-alpha", version: "1.0.0", sha256: "d".repeat(64) },
    fixtureManifestSha256: "e".repeat(64), checkerManifestSha256: "f".repeat(64), admissionContractSha256: "0".repeat(64),
    toolingSourceManifestSha256: "1".repeat(64), bindingSha256: "2".repeat(64),
    runtime: { nodeVersion: "v22.23.2", sdkVersion: "1.0.13", sdkLockSha256: "3".repeat(64), cliVersion: "1.0.84-1", cliSha256: "4".repeat(64), qualificationReceiptSha256: "5".repeat(64), sessionMode: "interactive" },
    activation: { subjectAgent: "fixture-worker", compositionSeam: "qualified-native-agent", requestedConfigurationSha256: "6".repeat(64) },
    attemptPolicy: { maxAttemptsPerCell: 1, automaticRetry: false },
    expectedCells: { path: "expected-cells.json", sha256: "c".repeat(64) },
  };
  const expected = { schemaVersion: 1, cells: [{ id: "cell-1", caseId: "case-1", executionKind: "deterministic", subject: null, judge: null }] };
  change(plan, expected);
  return revisionPublication({ plan, expected, revision: { repository: "owner/approved-repository", ref: "refs/pull/17/merge", head } });
};
const scoredRequest = head => ({ schemaVersion: 1, kind: "relevant_revision_request", repository: "owner/approved-repository", ref: "refs/pull/17/merge", head, previousHeads: [], changedPaths: ["evals/offline/scored-comparison.mjs"], events: [{ eventId: "delivery-1", receivedAt: "2026-01-01T00:00:00Z", head }] });
const scoredResult = (revision, change = () => {}) => {
  const value = {
    schemaVersion: 1, status: "complete", expectedCells: 1, attempts: 1, unstarted: 0,
    scored: true, grade: { summary: "synthetic public evaluation" }, revision,
    attemptStatuses: [{ attemptId: "attempt-1", cellId: "cell-1", status: "passed", published: true }],
  };
  change(value);
  return value;
};

test("a published native grade is admitted for exactly one revision and is never inherited or duplicated", () => {
  assert.equal(typeof revisionPublication, "function", "the controller must publish its revision binding");
  assert.equal(typeof skillEvals.revisionStatus, "function", "the CLI must expose relevant-revision status routing");
  const head = "a".repeat(40);
  const revision = controlled(head);
  const trustedControls = { schemaVersion: 1, kind: "trusted_evaluation_controls", source: "trusted_controller", approvedRevision: "9".repeat(40), controls: revision.controls };
  const status = (results, request = scoredRequest(head)) => skillEvals.revisionStatus({ request, trustedControls, results });
  const evaluated = status([scoredResult(revision)]);
  assert.equal(evaluated.status, "evaluated");
  assert.equal(evaluated.green, true);
  assert.equal(evaluated.scored, true);
  assert.deepEqual(evaluated.grade, { summary: "synthetic public evaluation" });
  for (const [change, disposition] of [
    [value => { value.scored = false; }, "INVALID_GRADE"],
    [value => { value.grade = null; }, "INVALID_GRADE"],
    [value => { value.grade = ["pass"]; }, "MALFORMED_GRADE"],
    // The aggregate surface is one bounded summary; a nested verdict set is not a single admitted grade.
    [value => { value.grade = { summary: "synthetic public evaluation", verdict: "pass" }; }, "MALFORMED_GRADE"],
    [value => { value.grade = { grades: [{ verdict: "pass" }, { verdict: "fail" }] }; }, "MALFORMED_GRADE"],
    [value => { value.grade = { summary: null }; }, "MALFORMED_GRADE"],
    [value => { value.attemptStatuses[0].status = "cancelled"; }, "CANCELLED"],
    [value => { value.attemptStatuses[0].status = "infrastructure_failure"; }, "RUNTIME_FAILURE"],
    [value => { value.status = "incomplete"; value.reason = "native_producer_not_qualified"; }, "AUTH_FAILURE"],
    [value => { value.attempts = 2; }, "HISTORY_GAP"],
  ]) {
    const report = status([scoredResult(revision, change)]);
    assert.equal(report.results[0].disposition, disposition);
    assert.equal(report.status, "failed");
    assert.equal(report.green, false);
    assert.equal(report.grade, null);
  }
  const duplicated = status([scoredResult(revision), scoredResult(revision)]);
  assert.equal(duplicated.reason, "MULTIPLE_COMPATIBLE_RESULTS");
  assert.equal(duplicated.green, false);
  const changedGrader = status([scoredResult(controlled(head, plan => { plan.checkerManifestSha256 = "a".repeat(64); }))]);
  assert.equal(changedGrader.results[0].disposition, "CONTROL_FINGERPRINT_MISMATCH");
  assert.equal(changedGrader.green, false);
  const changedBaseline = status([scoredResult(controlled(head, plan => { plan.comparison.policySha256 = "a".repeat(64); }))]);
  assert.equal(changedBaseline.results[0].disposition, "BASELINE_CHANGED");
  assert.equal(changedBaseline.green, false);
});
