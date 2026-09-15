import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { repository } from "./helpers/paths.mjs";

const moduleUrl = pathToFileURL(resolve(repository, "evals/offline/comparison.mjs"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const sha = (name) => hash(name);
const ref = (path) => ({ path, sha256: sha(path) });
const role = (model, invocationMode) => ({
  provider: "copilot",
  model,
  reasoningEffort: "high",
  contextTier: "default",
  invocationMode,
  promptSha256: sha(`${invocationMode}-prompt`),
  runtimeOptionsSha256: sha(`${invocationMode}-options`),
});
const cell = (id, caseId) => ({
  id,
  caseId,
  candidateId: "candidate-a",
  repetition: 1,
  executionKind: "subject_with_judge",
  subject: role("gpt-6-astra", "native-subject"),
  judge: role("claude-opus-5", "empty-judge"),
});

function plan(dimension = "candidate") {
  return {
    schemaVersion: 1,
    kind: "offline_run_plan",
    runSetId: "set-a",
    sourceHashScheme: "sha256/raw-bytes",
    comparison: { groupId: "group", dimension, treatmentId: "a", policySha256: sha("policy") },
    candidate: {
      id: "candidate-a",
      repository: "owner/approved-repository",
      sourceCommit: "a".repeat(40),
      sourceManifestSha256: sha("source"),
      nonMethodSourceManifestSha256: sha("non-method-source"),
      method: { id: "method", version: "1.0.0", payloadManifest: ref("method-manifest.json") },
      installationReceiptSha256: sha("installation"),
    },
    dataset: { id: "fixed", version: "1.0.0", sha256: sha("dataset") },
    fixtureManifestSha256: sha("fixtures"),
    checkerManifestSha256: sha("checks"),
    admissionContractSha256: sha("admission"),
    toolingSourceManifestSha256: sha("tooling"),
    runtime: { nodeVersion: "v22.23.2", sdkVersion: "1.0.13", sdkLockSha256: sha("sdk-lock"), cliVersion: "1.0.84-1", cliSha256: sha("cli"), qualificationReceiptSha256: sha("qualification"), sessionMode: "interactive" },
    expectedCells: ref("expected-cells.json"),
    attemptPolicy: { maxAttemptsPerCell: 1, automaticRetry: false },
    bindingSha256: sha("binding"),
    activation: { subjectAgent: "fixture-worker", compositionSeam: "qualified-native-agent", requestedConfigurationSha256: sha("requested-native-config"), qualificationReceipt: ref("activation-qualification.json") },
    gitSeeds: [],
    limits: { startupSendWorkMs: 100, cleanup: { totalMs: 30, abortMs: 10, stopMs: 10 }, maxStreamBytes: 1024, maxFileBytes: 1024, maxTotalBytes: 8192, maxFiles: 32 },
  };
}

function inventoryFixture(started = 2, { sameCaseDifferentRoles = false, duplicateLogicalCell = false } = {}) {
  const artifacts = new Map();
  const put = (path, value) => {
    const data = bytes(value);
    artifacts.set(path, data);
    return { path, sha256: hash(data) };
  };
  const expectedCells = { schemaVersion: 1, cells: [cell("cell-pass", "case-pass"), cell("cell-fail", "case-fail")] };
  if (sameCaseDifferentRoles || duplicateLogicalCell) expectedCells.cells[1].caseId = expectedCells.cells[0].caseId;
  if (sameCaseDifferentRoles) {
    expectedCells.cells[1].subject.model = "claude-opus-5";
    expectedCells.cells[1].judge.model = "gpt-6-astra";
  }
  const journalRecords = [];
  const attempts = expectedCells.cells.slice(0, started).map((entry, index) => {
    const attemptId = `attempt-${index + 1}`;
    const status = index === 0 ? "passed" : "product_failure";
    const receipt = put(`${attemptId}/receipt.json`, { schemaVersion: 1, runId: attemptId, caseId: entry.caseId, cellId: entry.id, executionKind: entry.executionKind, status });
    const inventory = put(`${attemptId}/inventory.json`, { schemaVersion: 1, files: [{ path: "receipt.json", mode: 384, bytes: artifacts.get(receipt.path).length, sha256: receipt.sha256 }] });
    const commitMarker = put(`${attemptId}/COMMITTED.json`, { schemaVersion: 1, kind: "offline_commit", runId: attemptId, inventory: { path: "inventory.json", sha256: inventory.sha256 }, receipt: { path: "receipt.json", sha256: receipt.sha256 } });
    const common = { schemaVersion: 1, runSetId: "set-a", attemptId, cellId: entry.id, timestamp: "2026-01-01T00:00:00Z" };
    const append = (record) => journalRecords.push({
      ...record,
      sequence: journalRecords.length + 1,
      previousRecordSha256: journalRecords.length ? hash(bytes(journalRecords.at(-1))) : null,
    });
    append({ ...common, type: "attempt_start", status: null, receipt: null, commitMarker: null });
    append({ ...common, type: "attempt_close", status, receipt, commitMarker });
    return { attemptId, cellId: entry.id, sequence: 1, status, receipt, commitMarker };
  });
  const journalBytes = Buffer.concat(journalRecords.map(bytes));
  artifacts.set("attempt-journal.jsonl", journalBytes);
  const expectedCellsRef = put("expected-cells.json", expectedCells);
  const frozenPlan = plan();
  frozenPlan.expectedCells = expectedCellsRef;
  const runSet = {
    schemaVersion: 1,
    kind: "offline_run_set",
    runSetId: "set-a",
    state: started < expectedCells.cells.length ? "incomplete" : "complete",
    plan: put("plan.json", frozenPlan),
    expectedCells: expectedCellsRef,
    attemptJournal: { path: "attempt-journal.jsonl", sha256: hash(journalBytes) },
    attempts,
    unstartedCellIds: expectedCells.cells.slice(started).map((entry) => entry.id),
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: "2026-01-01T00:00:01Z",
  };
  return { runSet, expectedCells, journalRecords, artifacts, readArtifact: (path) => {
    assert.ok(artifacts.has(path), `Missing artifact ${path}`);
    return artifacts.get(path);
  } };
}

test("the inventory-only helper retains a product-failure row alongside a passed row", async () => {
  const { validateRunSetInventory } = await import(moduleUrl);
  const fixture = inventoryFixture();
  const result = validateRunSetInventory(fixture);
  assert.equal(result.inventoryComplete, true);
  assert.deepEqual(result.cells.map((entry) => entry.status), ["passed", "product_failure"]);
});

for (const [name, mutate] of [
  ["omitted failing attempt", (fixture) => { fixture.runSet.attempts.pop(); }],
  ["duplicated attempt", (fixture) => { fixture.runSet.attempts.push(structuredClone(fixture.runSet.attempts[0])); }],
  ["empty supposedly complete set", (fixture) => { fixture.runSet.attempts = []; }],
  ["unknown expected cell", (fixture) => { fixture.runSet.attempts[0].cellId = "undeclared"; }],
  ["duplicate logical expected cell", (fixture) => { fixture.expectedCells.cells[1] = { ...fixture.expectedCells.cells[0], id: "different-id" }; }],
  ["omitted journal attempt", (fixture) => { fixture.journalRecords.splice(2, 2); }],
  ["receipt hash mismatch", (fixture) => { fixture.artifacts.set(fixture.runSet.attempts[1].receipt.path, bytes({ status: "passed" })); }],
  ["receipt missing", (fixture) => { fixture.artifacts.delete(fixture.runSet.attempts[1].receipt.path); }],
  ["receipt identity mismatch", (fixture) => {
    const attempt = fixture.runSet.attempts[0];
    const data = bytes({ schemaVersion: 1, runId: "another-attempt", cellId: attempt.cellId, caseId: "case-pass", status: attempt.status });
    fixture.artifacts.set(attempt.receipt.path, data);
    attempt.receipt.sha256 = hash(data);
  }],
]) {
  test(`${name} cannot be converted into a winning complete inventory`, async () => {
    const { validateRunSetInventory } = await import(moduleUrl);
    const fixture = inventoryFixture();
    mutate(fixture);
    assert.throws(() => validateRunSetInventory(fixture));
  });
}

test("unpublished cells remain explicitly incomplete", async () => {
  const { validateRunSetInventory } = await import(moduleUrl);
  const fixture = inventoryFixture();
  fixture.runSet.state = "incomplete";
  fixture.artifacts.delete(fixture.runSet.attempts[1].commitMarker.path);
  fixture.runSet.attempts[1].commitMarker = null;
  fixture.journalRecords.at(-1).commitMarker = null;
  const journalBytes = Buffer.concat(fixture.journalRecords.map(bytes));
  fixture.artifacts.set("attempt-journal.jsonl", journalBytes);
  fixture.runSet.attemptJournal.sha256 = hash(journalBytes);
  const result = validateRunSetInventory(fixture);
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.cells.length, 2);
  assert.equal(result.cells[1].status, "product_failure");
});

test("an expected cell never started remains visible rather than disappearing", async () => {
  const { validateRunSetInventory } = await import(moduleUrl);
  const result = validateRunSetInventory(inventoryFixture(1));
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.cells.length, 2);
  const missing = result.cells.find((entry) => entry.cellId === "cell-fail");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.attemptId, null);
});

test("same candidate dimension requires both complete role configurations", async () => {
  const { checkComparisonCompatibility } = await import(moduleUrl);
  const leftPlan = plan();
  const rightPlan = structuredClone(leftPlan);
  rightPlan.runSetId = "set-b";
  rightPlan.comparison.treatmentId = "b";
  rightPlan.candidate.id = "candidate-b";
  rightPlan.candidate.sourceCommit = "b".repeat(40);
  rightPlan.candidate.sourceManifestSha256 = sha("different candidate source");
  rightPlan.candidate.installationReceiptSha256 = sha("different installation");
  const leftCells = { schemaVersion: 1, cells: [cell("cell", "case")] };
  const rightCells = structuredClone(leftCells);
  rightCells.cells[0].candidateId = "candidate-b";
  assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells, rightCells }).compatible, true);
  rightCells.cells[0].judge.promptSha256 = sha("different judge prompt");
  assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells, rightCells }).compatible, false);
});

for (const roleName of ["subject", "judge"]) for (const field of ["provider", "model", "reasoningEffort", "contextTier", "invocationMode", "promptSha256", "runtimeOptionsSha256"]) {
  test(`an unexpected ${roleName} ${field} change is not a candidate comparison`, async () => {
    const { checkComparisonCompatibility } = await import(moduleUrl);
    const leftPlan = plan();
    const rightPlan = structuredClone(leftPlan);
    const leftCells = { schemaVersion: 1, cells: [cell("cell", "case")] };
    const rightCells = structuredClone(leftCells);
    rightCells.cells[0][roleName][field] = field.endsWith("Sha256") ? sha(`different-${field}`) : `different-${field}`;
    assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells, rightCells }).compatible, false);
  });
}

test("model_pair is unsupported in alpha even if both models qualify separately", async () => {
  const { checkComparisonCompatibility } = await import(moduleUrl);
  const leftPlan = plan("model_pair");
  const rightPlan = structuredClone(leftPlan);
  const leftCells = { schemaVersion: 1, cells: [cell("cell", "case")] };
  const rightCells = structuredClone(leftCells);
  rightCells.cells[0].subject.model = "claude-opus-5";
  rightCells.cells[0].judge.model = "gpt-6-astra";
  const result = checkComparisonCompatibility({ leftPlan, rightPlan, leftCells, rightCells });
  assert.equal(result.compatible, false);
  assert.equal(result.reason, "MODEL_COMPARISON_UNSUPPORTED_IN_ALPHA");
});

test("same case and repetition in a different complete role pair is a distinct expected cell", async () => {
  const { validateRunSetInventory } = await import(moduleUrl);
  const fixture = inventoryFixture(2, { sameCaseDifferentRoles: true });
  const result = validateRunSetInventory(fixture);
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.cells.length, 2);
});

test("a consistently sealed duplicate logical cell is still rejected", async () => {
  const { validateRunSetInventory } = await import(moduleUrl);
  assert.throws(() => validateRunSetInventory(inventoryFixture(2, { duplicateLogicalCell: true })));
});

test("method comparison cannot hide changed non-method source bytes", async () => {
  const { checkComparisonCompatibility } = await import(moduleUrl);
  const leftPlan = plan("method");
  const rightPlan = structuredClone(leftPlan);
  rightPlan.candidate.nonMethodSourceManifestSha256 = sha("changed application");
  const cells = { schemaVersion: 1, cells: [cell("cell", "case")] };
  assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells: cells, rightCells: cells }).compatible, false);
});

test("legacy normalized source fingerprints cannot substitute for raw source provenance", async () => {
  const { checkComparisonCompatibility } = await import(moduleUrl);
  const leftPlan = plan();
  const rightPlan = structuredClone(leftPlan);
  delete rightPlan.candidate.sourceManifestSha256;
  rightPlan.candidate.sourceFingerprint = leftPlan.candidate.sourceManifestSha256;
  const cells = { schemaVersion: 1, cells: [cell("cell", "case")] };
  assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells: cells, rightCells: cells }).compatible, false);
});

test("field-level compatibility does not confuse JSON property order with a changed role or runtime", async () => {
  const { checkComparisonCompatibility } = await import(moduleUrl);
  const leftPlan = plan();
  const rightPlan = structuredClone(leftPlan);
  rightPlan.runtime = Object.fromEntries(Object.entries(rightPlan.runtime).reverse());
  const cells = { schemaVersion: 1, cells: [cell("cell", "case")] };
  assert.equal(checkComparisonCompatibility({ leftPlan, rightPlan, leftCells: cells, rightCells: cells }).compatible, true);
});

const controllerUrl = pathToFileURL(resolve(repository, "evals/offline/fixed-controller.mjs"));
const revisionRequest = (head, change = () => {}) => {
  const value = {
    schemaVersion: 1,
    kind: "relevant_revision_request",
    repository: "owner/approved-repository",
    ref: "refs/pull/17/merge",
    head,
    previousHeads: [],
    changedPaths: ["evals/offline/fixed-controller.mjs"],
    events: [{ eventId: "delivery-1", receivedAt: "2026-01-01T00:00:00Z", head }],
  };
  change(value);
  return value;
};

test("the controller publishes exactly its frozen plan identity as the evaluated revision", async () => {
  const controller = await import(controllerUrl);
  assert.equal(typeof controller.revisionPublication, "function", "the controller must publish its revision binding");
  const frozenPlan = plan();
  const expected = { schemaVersion: 1, cells: [cell("cell-judged", "case-judged"), { ...cell("cell-fixed", "case-fixed"), executionKind: "deterministic", subject: null, judge: null }] };
  const head = frozenPlan.candidate.sourceCommit;
  const published = controller.revisionPublication({ plan: frozenPlan, expected, revision: { repository: "owner/approved-repository", ref: "refs/pull/17/merge", head } });
  assert.equal(published.repository, "owner/approved-repository");
  assert.equal(published.ref, "refs/pull/17/merge");
  assert.equal(published.head, head);
  assert.deepEqual(published.controls.dataset, frozenPlan.dataset);
  assert.deepEqual(published.controls.runtime, frozenPlan.runtime);
  assert.deepEqual(published.controls.baseline, { groupId: frozenPlan.comparison.groupId, policySha256: frozenPlan.comparison.policySha256 });
  assert.equal(published.controls.roles.length, 2);
  assert.deepEqual(published.controls.roles[0], [
    ["copilot", "gpt-6-astra", "high", "default", "native-subject", sha("native-subject-prompt"), sha("native-subject-options")],
    ["copilot", "claude-opus-5", "high", "default", "empty-judge", sha("empty-judge-prompt"), sha("empty-judge-options")],
  ]);
  assert.deepEqual(published.controls.roles[1], [null, null]);
  assert.equal(controller.revisionPublication({ plan: frozenPlan, expected, revision: undefined }), null);
  assert.equal(controller.revisionPublication({ plan: frozenPlan, expected, revision: null }), null);
  for (const [revision, code] of [
    [{ repository: "owner/other-repository", ref: "refs/heads/main", head }, "REVISION_BINDING_MISMATCH"],
    [{ repository: "owner/approved-repository", ref: "refs/heads/main", head: "d".repeat(40) }, "REVISION_BINDING_MISMATCH"],
    [{ repository: "owner/approved-repository", ref: " ", head }, "REVISION_BINDING_INVALID"],
    [{ repository: "owner/approved-repository", ref: "refs/heads/main", head, grader: "candidate" }, "REVISION_BINDING_INVALID"],
    [{ repository: "owner/approved-repository", head }, "REVISION_BINDING_INVALID"],
    ["refs/heads/main", "REVISION_BINDING_INVALID"],
  ]) assert.throws(() => controller.revisionPublication({ plan: frozenPlan, expected, revision }), { code });
});

test("a published controller revision reconciles only against its own exact head and frozen controls", async () => {
  const controller = await import(controllerUrl);
  const skillEvals = (await import(pathToFileURL(resolve(repository, "scripts/skill-evals.cjs")))).default;
  assert.equal(typeof skillEvals.revisionStatus, "function", "the CLI must expose relevant-revision status routing");
  const frozenPlan = plan();
  const expected = { schemaVersion: 1, cells: [cell("cell-judged", "case-judged")] };
  const head = frozenPlan.candidate.sourceCommit;
  const published = controller.revisionPublication({ plan: frozenPlan, expected, revision: { repository: "owner/approved-repository", ref: "refs/pull/17/merge", head } });
  const trustedControls = { schemaVersion: 1, kind: "trusted_evaluation_controls", source: "trusted_controller", approvedRevision: "9".repeat(40), controls: published.controls };
  const result = {
    schemaVersion: 1, status: "complete", expectedCells: 1, attempts: 1, unstarted: 0,
    scored: true, grade: { summary: "synthetic public evaluation" }, revision: published,
    attemptStatuses: [{ attemptId: "attempt-1", cellId: "cell-judged", status: "passed", published: true }],
  };
  const evaluated = skillEvals.revisionStatus({ request: revisionRequest(head), trustedControls, results: [result] });
  assert.equal(evaluated.status, "evaluated");
  assert.equal(evaluated.green, true);
  assert.equal(evaluated.revision.controlsFingerprint, evaluated.trustedControls.controlsFingerprint);
  // A candidate that changes its own judge configuration no longer matches the trusted controller's controls.
  const retuned = { schemaVersion: 1, cells: [{ ...cell("cell-judged", "case-judged"), judge: { ...cell("cell-judged", "case-judged").judge, model: "gpt-6-astra" } }] };
  const retunedResult = { ...result, revision: controller.revisionPublication({ plan: frozenPlan, expected: retuned, revision: { repository: "owner/approved-repository", ref: "refs/pull/17/merge", head } }) };
  const incompatible = skillEvals.revisionStatus({ request: revisionRequest(head), trustedControls, results: [retunedResult] });
  assert.equal(incompatible.results[0].disposition, "CONTROL_FINGERPRINT_MISMATCH");
  assert.equal(incompatible.status, "pending");
  assert.equal(incompatible.green, false);
  // The same published result cannot be inherited by the next head.
  const nextHead = skillEvals.revisionStatus({ request: revisionRequest("e".repeat(40), value => { value.previousHeads = [head]; }), trustedControls, results: [result] });
  assert.equal(nextHead.results[0].disposition, "PREVIOUS_HEAD");
  assert.equal(nextHead.status, "pending");
  assert.equal(nextHead.green, false);
});
