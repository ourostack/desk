#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { contractFingerprint, sourceFingerprint, validateRepo, verifyReceipt, revisionStatus } = require("./skill-evals.cjs");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "skill-evals.cjs");
const tempDirs = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(root, ".skill-evals-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "evals"));
  fs.writeFileSync(path.join(dir, "source.txt"), "original\n");
  const suite = {
    schemaVersion: 1,
    id: "fixture",
    description: "Fixture suite.",
    sources: ["source.txt"],
    reviewedSourceFingerprint: sourceFingerprint(["source.txt"], dir),
    requirements: [
      { id: "r1", description: "First requirement." },
      { id: "r2", description: "Second requirement." },
    ],
    cases: [{
      id: "case-1",
      description: "Fixture case.",
      prompt: "Evaluate the fixture.",
      checks: [
        { id: "check-must", polarity: "must", evidenceType: "response", covers: ["r1"], description: "Required evidence." },
        { id: "check-must-not", polarity: "must_not", evidenceType: "tool_call", covers: ["r2"], description: "Forbidden evidence." },
      ],
    }],
  };
  fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
  return { dir, suite };
}

function receipt(suite) {
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    sourceFingerprint: suite.reviewedSourceFingerprint,
    contractFingerprint: contractFingerprint(suite),
    run: {
      actor: "fixture actor",
      model: "fixture model",
      runtimeRevision: "fixture revision",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
    },
    cases: suite.cases.map((testCase) => ({
      id: testCase.id,
      checks: testCase.checks.map((check) => ({ id: check.id, passed: true, evidence: "External harness receipt." })),
    })),
  };
}

const revisionHead = "a".repeat(40);
const revisionPreviousHead = "b".repeat(40);
const revisionApproved = "c".repeat(40);
const hex = (character) => character.repeat(64);

function revisionControls(change = () => {}) {
  const controls = {
    dataset: { id: "engineering-v2-alpha", version: "1.0.0", sha256: hex("d") },
    fixtureManifestSha256: hex("e"),
    checkerManifestSha256: hex("f"),
    admissionContractSha256: hex("0"),
    toolingSourceManifestSha256: hex("1"),
    bindingSha256: hex("2"),
    runtime: { nodeVersion: "v22.23.2", sdkVersion: "1.0.13", sdkLockSha256: hex("3"), cliVersion: "1.0.84-1", cliSha256: hex("4"), qualificationReceiptSha256: hex("5"), sessionMode: "interactive" },
    activation: { subjectAgent: "fixture-worker", compositionSeam: "qualified-native-agent", requestedConfigurationSha256: hex("6") },
    attemptPolicy: { maxAttemptsPerCell: 1, automaticRetry: false },
    baseline: { groupId: "alpha-group", policySha256: hex("7") },
    roles: [
      [["copilot", "gpt-6-astra", "high", "default", "native-subject", hex("8"), hex("9")], ["copilot", "claude-opus-5", "high", "default", "empty-judge", hex("a"), hex("b")]],
      [null, null],
    ],
  };
  change(controls);
  return controls;
}

function trustedControls(change = () => {}) {
  const value = {
    schemaVersion: 1,
    kind: "trusted_evaluation_controls",
    source: "trusted_controller",
    approvedRevision: revisionApproved,
    controls: revisionControls(),
  };
  change(value);
  return value;
}

function revisionRequest(change = () => {}) {
  const value = {
    schemaVersion: 1,
    kind: "relevant_revision_request",
    repository: "owner/public-alpha",
    ref: "refs/pull/17/merge",
    head: revisionHead,
    previousHeads: [revisionPreviousHead],
    changedPaths: ["evals/offline/checks.mjs"],
    events: [{ eventId: "delivery-1", receivedAt: "2026-09-15T00:00:00Z", head: revisionHead }],
  };
  change(value);
  return value;
}

function revisionResult(change = () => {}) {
  const value = {
    schemaVersion: 1,
    status: "complete",
    expectedCells: 2,
    attempts: 2,
    unstarted: 0,
    scored: true,
    grade: { summary: "synthetic public evaluation" },
    revision: { repository: "owner/public-alpha", ref: "refs/pull/17/merge", head: revisionHead, controls: revisionControls() },
    attemptStatuses: [
      { attemptId: "attempt-1", cellId: "cell-1", status: "passed", published: true },
      { attemptId: "attempt-2", cellId: "cell-2", status: "product_failure", published: true },
    ],
  };
  change(value);
  return value;
}

const revisionCase = (request, results = [], controls = trustedControls()) => revisionStatus({ request, trustedControls: controls, results });
const soleDisposition = (report) => report.results.map((entry) => entry.disposition).join(",");

try {
  assert.doesNotThrow(() => validateRepo(root));
  const validation = spawnSync(process.execPath, [cli, "validate"], { cwd: root, encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /behavior: UNVERIFIED - validation does not run or judge an agent/u);

  const fingerprint = spawnSync(
    process.execPath,
    [cli, "fingerprint", "evals/investigation-boundaries.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(fingerprint.status, 0, fingerprint.stderr);
  const currentFingerprints = JSON.parse(fingerprint.stdout);
  assert.match(currentFingerprints.sourceFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(currentFingerprints.contractFingerprint, /^[a-f0-9]{64}$/u);

  {
    const { dir } = makeFixture();
    fs.writeFileSync(path.join(dir, "source.txt"), "changed\n");
    assert.throws(() => validateRepo(dir), /reviewedSourceFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.requirements.push({ id: "uncovered", description: "Uncovered requirement." });
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /uncovered requirement/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.cases[0].checks[1].id = "check-must";
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /duplicate check id/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.sources = ["../outside.txt"];
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /source path escapes repo root/u);
  }

  {
    const { dir, suite } = makeFixture();
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(receipt(suite), null, 2)}\n`);
    assert.doesNotThrow(() => verifyReceipt(resultFile, dir));
    const verification = spawnSync(process.execPath, [cli, "verify", resultFile, dir], { encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /receipt is complete\/current and evidence was not judged/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    suite.cases[0].checks[0].description = "Changed requirement evidence.";
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /contractFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.cases[0].checks.pop();
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /missing check/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.sourceFingerprint = "stale";
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /sourceFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.run.startedAt = "2026-02-30T12:00:00Z";
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /valid UTC ISO timestamp/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.cases[0].checks[0].passed = false;
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /failed check/u);
  }

  assert.equal(typeof revisionStatus, "function", "the shipped CLI must expose relevant-revision status routing");

  // Relevance: evaluator/offline source, selected skill/instruction/dependency/runtime source and the alpha itself
  // are relevant; an unrelated own-desk-only Markdown change is not.
  {
    const offlineOnly = revisionCase(revisionRequest());
    assert.equal(offlineOnly.relevance.relevant, true);
    assert.deepEqual(offlineOnly.relevance.categories, ["evaluator_source"]);
    assert.equal(offlineOnly.status, "pending");
    assert.equal(offlineOnly.green, false);
    assert.equal(offlineOnly.scored, false);
    assert.equal(offlineOnly.grade, null);
    assert.equal(offlineOnly.reason, "NO_RESULT_RETURNED");

    for (const [changed, category] of [
      ["plugins/desk/skills/start-task/SKILL.md", "selected_source"],
      ["plugins/desk/principles.md", "selected_source"],
      ["skills/work-doer/SKILL.md", "selected_source"],
      ["AGENTS.md", "selected_source"],
      ["upstream-sources.lock.json", "runtime_source"],
      ["plugins/desk/mcp/src/index.js", "runtime_source"],
      ["plugins/desk/mcp/package-lock.json", "runtime_source"],
      [".github/workflows/desk-mcp-tests.yml", "workflow_control"],
      ["evals/offline/cases/v2-alpha-v1/dataset.json", "alpha"],
      ["AGENTIC-ENGINEERING-V2.md", "alpha"],
      ["evals/engineering-v2-kernel.json", "alpha"],
    ]) {
      const report = revisionCase(revisionRequest((value) => { value.changedPaths = [changed]; }));
      assert.deepEqual(report.relevance.categories, [category], changed);
      assert.equal(report.relevance.relevant, true, changed);
      assert.equal(report.status, "pending", changed);
      assert.notEqual(report.status, "not_applicable", changed);
    }

    for (const changed of ["desk/tasks/2026-09-15-notes.md", "README.md"]) {
      const report = revisionCase(revisionRequest((value) => { value.changedPaths = [changed]; }));
      assert.equal(report.relevance.relevant, false, changed);
      assert.equal(report.status, "not_applicable", changed);
      assert.equal(report.green, false, changed);
    }

    // A mixed revision that also touches own-desk Markdown is still relevant through its evaluator change.
    const mixed = revisionCase(revisionRequest((value) => { value.changedPaths = ["desk/tasks/notes.md", "evals/offline/fixed-controller.mjs"]; }));
    assert.equal(mixed.relevance.relevant, true);
    assert.deepEqual(mixed.relevance.paths.map((entry) => entry.category), ["own_desk", "evaluator_source"]);
    assert.deepEqual(mixed.relevance.trustedControlPaths, ["evals/offline/fixed-controller.mjs"]);

    // The alpha can never be reported not applicable merely because no model result exists.
    const alphaWithoutResult = revisionCase(revisionRequest((value) => { value.changedPaths = ["evals/offline/cases/v2-alpha-v1/check-expectations.json"]; }), []);
    assert.equal(alphaWithoutResult.status, "pending");
    assert.equal(alphaWithoutResult.relevance.relevant, true);
    assert.notEqual(alphaWithoutResult.status, "not_applicable");
  }

  // Revision identity: repository, ref, exact head and the frozen control fingerprint.
  {
    const report = revisionCase(revisionRequest());
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, "relevant_revision_status");
    assert.equal(report.revision.repository, "owner/public-alpha");
    assert.equal(report.revision.ref, "refs/pull/17/merge");
    assert.equal(report.revision.head, revisionHead);
    assert.match(report.revision.controlsFingerprint, /^[a-f0-9]{64}$/u);
    assert.match(report.revision.revisionId, /^[a-f0-9]{64}$/u);
    assert.equal(report.runIdentity, report.revision.revisionId);
    assert.equal(report.trustedControls.available, true);
    assert.equal(report.trustedControls.approvedRevision, revisionApproved);

    const differentHead = revisionCase(revisionRequest((value) => { value.head = "d".repeat(40); }));
    assert.notEqual(differentHead.revision.revisionId, report.revision.revisionId);
    const differentRef = revisionCase(revisionRequest((value) => { value.ref = "refs/heads/v2-alpha"; }));
    assert.notEqual(differentRef.revision.revisionId, report.revision.revisionId);
    const differentControls = revisionCase(revisionRequest(), [], trustedControls((value) => { value.controls.checkerManifestSha256 = hex("a"); }));
    assert.notEqual(differentControls.revision.revisionId, report.revision.revisionId);
    // Property order alone is not a different frozen control set.
    const reordered = revisionCase(revisionRequest(), [], trustedControls((value) => { value.controls.runtime = Object.fromEntries(Object.entries(value.controls.runtime).reverse()); }));
    assert.equal(reordered.revision.controlsFingerprint, report.revision.controlsFingerprint);
  }

  // Duplicate revision events converge on one run identity while every attempt and history record is retained.
  {
    const report = revisionCase(revisionRequest((value) => {
      value.events = [
        { eventId: "delivery-1", receivedAt: "2026-09-15T00:00:00Z", head: revisionHead },
        { eventId: "delivery-2", receivedAt: "2026-09-15T00:00:01Z", head: revisionHead },
        { eventId: "delivery-1", receivedAt: "2026-09-15T00:00:02Z", head: revisionHead },
        { eventId: "delivery-3", receivedAt: "2026-09-15T00:00:03Z", head: revisionPreviousHead },
        { eventId: "delivery-4", receivedAt: "2026-09-15T00:00:04Z", head: "e".repeat(40) },
      ];
    }));
    assert.equal(report.events.length, 5);
    assert.deepEqual(report.events.map((event) => event.disposition), ["primary", "duplicate", "redelivery", "superseded_head", "foreign_head"]);
    assert.deepEqual(report.events.map((event) => event.duplicateOf), [null, "delivery-1", "delivery-1", null, null]);
    const identities = new Set(report.events.filter((event) => event.runIdentity !== null).map((event) => event.runIdentity));
    assert.equal(identities.size, 1);
    assert.equal([...identities][0], report.runIdentity);
    assert.deepEqual(report.events.map((event) => event.receivedAt), ["2026-09-15T00:00:00Z", "2026-09-15T00:00:01Z", "2026-09-15T00:00:02Z", "2026-09-15T00:00:03Z", "2026-09-15T00:00:04Z"]);
    assert.equal(report.status, "pending");
  }

  // A compatible result for the exact head and exact frozen controls is the only green.
  {
    const withoutResults = revisionStatus({ request: revisionRequest(), trustedControls: trustedControls() });
    assert.equal(withoutResults.status, "pending");
    assert.deepEqual(withoutResults.results, []);
    assert.equal(withoutResults.reason, "NO_RESULT_RETURNED");
    const evaluated = revisionCase(revisionRequest(), [revisionResult()]);
    assert.equal(evaluated.status, "evaluated");
    assert.equal(evaluated.green, true);
    assert.equal(evaluated.scored, true);
    assert.deepEqual(evaluated.grade, { summary: "synthetic public evaluation" });
    assert.equal(soleDisposition(evaluated), "COMPATIBLE");
  }

  // Previous, superseded and foreign heads never colour the current head green.
  {
    const previous = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.head = revisionPreviousHead; })]);
    assert.equal(soleDisposition(previous), "PREVIOUS_HEAD");
    assert.equal(previous.status, "pending");
    assert.equal(previous.green, false);
    assert.equal(previous.reason, "NO_COMPATIBLE_RESULT");

    const foreign = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.head = "f".repeat(40); })]);
    assert.equal(soleDisposition(foreign), "FOREIGN_HEAD");
    assert.equal(foreign.green, false);

    const otherRepository = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.repository = "owner/other"; })]);
    assert.equal(soleDisposition(otherRepository), "REPOSITORY_MISMATCH");

    const otherRef = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.ref = "refs/heads/main"; })]);
    assert.equal(soleDisposition(otherRef), "REF_MISMATCH");

    const unbound = revisionCase(revisionRequest(), [revisionResult((value) => { delete value.revision; })]);
    assert.equal(soleDisposition(unbound), "MISSING_REVISION_BINDING");
    assert.equal(unbound.results[0].revision, null);

    const malformed = revisionCase(revisionRequest(), [{ schemaVersion: 2 }]);
    assert.equal(soleDisposition(malformed), "MALFORMED_RESULT");
    assert.equal(revisionCase(revisionRequest(), ["not-an-object"]).results[0].disposition, "MALFORMED_RESULT");
  }

  // Changed fixture, grader, model, reasoning effort, context tier, runtime or baseline controls are incompatible.
  {
    for (const change of [
      (controls) => { controls.fixtureManifestSha256 = hex("a"); },
      (controls) => { controls.checkerManifestSha256 = hex("a"); },
      (controls) => { controls.dataset.sha256 = hex("a"); },
      (controls) => { controls.admissionContractSha256 = hex("a"); },
      (controls) => { controls.toolingSourceManifestSha256 = hex("a"); },
      (controls) => { controls.activation.requestedConfigurationSha256 = hex("a"); },
      (controls) => { controls.runtime.cliVersion = "1.0.85-1"; },
      (controls) => { controls.runtime.nodeVersion = "v24.0.0"; },
      (controls) => { controls.roles[0][0][1] = "claude-opus-5"; },
      (controls) => { controls.roles[0][0][2] = "medium"; },
      (controls) => { controls.roles[0][0][3] = "long_context"; },
      (controls) => { controls.roles[0][1][1] = "gpt-6-astra"; },
      (controls) => { controls.roles[1] = [null, null, null]; },
      (controls) => { controls.attemptPolicy.automaticRetry = true; },
    ]) {
      const report = revisionCase(revisionRequest(), [revisionResult((value) => { change(value.revision.controls); })]);
      assert.equal(soleDisposition(report), "CONTROL_FINGERPRINT_MISMATCH");
      assert.equal(report.status, "pending");
      assert.equal(report.green, false);
    }
    const baseline = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.controls.baseline.policySha256 = hex("a"); })]);
    assert.equal(soleDisposition(baseline), "BASELINE_CHANGED");
    assert.equal(baseline.green, false);
    const baselineGroup = revisionCase(revisionRequest(), [revisionResult((value) => { delete value.revision.controls.baseline; })]);
    assert.equal(soleDisposition(baselineGroup), "BASELINE_CHANGED");
  }

  // Auth/runtime failure, cancellation, lost history and invalid or multiple grading remain non-green.
  {
    const auth = revisionCase(revisionRequest(), [revisionResult((value) => { value.status = "incomplete"; value.reason = "native_producer_not_qualified"; })]);
    assert.equal(soleDisposition(auth), "AUTH_FAILURE");
    assert.equal(auth.status, "failed");
    assert.equal(auth.green, false);
    assert.equal(auth.reason, "AUTH_FAILURE");

    const runtime = revisionCase(revisionRequest(), [revisionResult((value) => { value.status = "incomplete"; })]);
    assert.equal(soleDisposition(runtime), "RUNTIME_FAILURE");
    assert.equal(runtime.status, "failed");

    const cancelled = revisionCase(revisionRequest(), [revisionResult((value) => { value.attemptStatuses[1].status = "cancelled"; })]);
    assert.equal(soleDisposition(cancelled), "CANCELLED");
    assert.equal(cancelled.status, "failed");

    const timedOut = revisionCase(revisionRequest(), [revisionResult((value) => { value.attemptStatuses[1].status = "timed_out"; })]);
    assert.equal(soleDisposition(timedOut), "RUNTIME_FAILURE");

    for (const change of [
      (value) => { value.attemptStatuses.pop(); },
      (value) => { value.unstarted = 1; },
      (value) => { value.attempts = 1; value.attemptStatuses.pop(); },
      (value) => { delete value.attemptStatuses; },
      (value) => { value.attemptStatuses[0] = { attemptId: "attempt-1" }; },
      (value) => { delete value.attemptStatuses[0].published; },
      (value) => { value.attemptStatuses[0].extra = true; },
      (value) => { value.attemptStatuses[0].attemptId = " "; },
      (value) => { value.attemptStatuses[0].cellId = " "; },
      (value) => { value.attemptStatuses[0].status = ""; },
      (value) => { value.attemptStatuses[1].cellId = "cell-1"; },
      // An attempt that reached a gradable status but was never committed is lost evidence, not a grade.
      (value) => { value.attemptStatuses[0].published = false; },
      (value) => { value.attemptStatuses[1].published = "yes"; },
    ]) {
      const report = revisionCase(revisionRequest(), [revisionResult(change)]);
      assert.equal(soleDisposition(report), "HISTORY_GAP");
      assert.equal(report.status, "failed");
      assert.equal(report.green, false);
    }
    // A cancelled attempt is reported as cancellation even though its publication never happened.
    const unpublishedCancellation = revisionCase(revisionRequest(), [revisionResult((value) => { value.attemptStatuses[0].status = "cancelled"; value.attemptStatuses[0].published = false; })]);
    assert.equal(soleDisposition(unpublishedCancellation), "CANCELLED");
    assert.equal(unpublishedCancellation.green, false);

    const unscored = revisionCase(revisionRequest(), [revisionResult((value) => { value.scored = false; })]);
    assert.equal(soleDisposition(unscored), "INVALID_GRADE");
    const ungraded = revisionCase(revisionRequest(), [revisionResult((value) => { value.grade = null; })]);
    assert.equal(soleDisposition(ungraded), "INVALID_GRADE");
    const malformedGrade = revisionCase(revisionRequest(), [revisionResult((value) => { value.grade = "pass"; })]);
    assert.equal(soleDisposition(malformedGrade), "MALFORMED_GRADE");
    const emptyGrade = revisionCase(revisionRequest(), [revisionResult((value) => { value.grade = {}; })]);
    assert.equal(soleDisposition(emptyGrade), "MALFORMED_GRADE");

    const multiple = revisionCase(revisionRequest(), [revisionResult(), revisionResult((value) => { value.grade = { summary: "second synthetic evaluation" }; })]);
    assert.equal(multiple.status, "failed");
    assert.equal(multiple.green, false);
    assert.equal(multiple.reason, "MULTIPLE_COMPATIBLE_RESULTS");
    assert.equal(multiple.grade, null);

    // A returned failure plus a stale previous-head result still cannot be inherited as green.
    const mixed = revisionCase(revisionRequest(), [revisionResult((value) => { value.revision.head = revisionPreviousHead; }), revisionResult((value) => { value.attemptStatuses[0].status = "cancelled"; })]);
    assert.deepEqual(mixed.results.map((entry) => entry.disposition), ["PREVIOUS_HEAD", "CANCELLED"]);
    assert.equal(mixed.status, "failed");
    assert.equal(mixed.green, false);
  }

  // Without installed trusted controls nothing can be inherited, and the revision stays pending.
  {
    const report = revisionStatus({ request: revisionRequest(), results: [revisionResult()] });
    assert.equal(report.trustedControls.available, false);
    assert.equal(report.trustedControls.approvedRevision, null);
    assert.equal(report.revision.controlsFingerprint, null);
    assert.equal(soleDisposition(report), "TRUSTED_CONTROLS_UNAVAILABLE");
    assert.equal(report.status, "pending");
    assert.equal(report.green, false);
    assert.equal(report.reason, "NO_COMPATIBLE_RESULT");
  }

  // The candidate is data only: it cannot approve its own grader, controls, workflow auth or model.
  {
    for (const [change, code] of [
      [(value) => { value.controls = revisionControls(); }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.grader = { model: "claude-opus-5" }; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.model = "gpt-6-astra"; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.runtime = { nodeVersion: "v22.23.2" }; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.baseline = { groupId: "alpha-group" }; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.auth = { token: "public-placeholder" }; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.workflow = ".github/workflows/candidate.yml"; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.approvedRevision = revisionHead; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.green = true; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.grade = { summary: "self graded" }; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.unexpected = 1; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.kind = "other"; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.head = "not-a-commit"; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.previousHeads = [revisionHead]; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.previousHeads = [revisionPreviousHead, revisionPreviousHead]; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.ref = " "; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.events = [{ eventId: "delivery-1", receivedAt: "not-a-time", head: revisionHead }]; }, "INVALID_REVISION_EVENT"],
      [(value) => { value.events = [{ eventId: "delivery-1", head: revisionHead }]; }, "INVALID_REVISION_EVENT"],
      [(value) => { value.changedPaths = ["/etc/passwd"]; }, "INVALID_CHANGED_PATH"],
      [(value) => { value.changedPaths = ["../outside.md"]; }, "INVALID_CHANGED_PATH"],
      [(value) => { value.changedPaths = ["evals/../../escape.md"]; }, "INVALID_CHANGED_PATH"],
      [(value) => { value.changedPaths = ["evals\\offline\\checks.mjs"]; }, "INVALID_CHANGED_PATH"],
      [(value) => { value.changedPaths = [""]; }, "INVALID_CHANGED_PATH"],
      [(value) => { value.changedPaths = "evals/offline/checks.mjs"; }, "INVALID_REVISION_REQUEST"],
      [(value) => { value.events = "delivery-1"; }, "INVALID_REVISION_REQUEST"],
    ]) {
      assert.throws(() => revisionCase(revisionRequest(change)), (error) => error.code === code, code);
    }
    assert.throws(() => revisionStatus({ request: null, trustedControls: trustedControls(), results: [] }), (error) => error.code === "INVALID_REVISION_REQUEST");
    assert.throws(() => revisionStatus({ request: revisionRequest(), trustedControls: trustedControls(), results: "results" }), (error) => error.code === "INVALID_REVISION_RESULTS");

    for (const [change, code] of [
      [(value) => { value.source = "candidate"; }, "UNTRUSTED_CONTROL_SOURCE"],
      [(value) => { value.approvedRevision = revisionHead; }, "CANDIDATE_SELF_APPROVAL"],
      [(value) => { value.approvedRevision = revisionPreviousHead; }, "CANDIDATE_SELF_APPROVAL"],
      [(value) => { value.kind = "candidate_controls"; }, "INVALID_TRUSTED_CONTROLS"],
      [(value) => { value.schemaVersion = 2; }, "INVALID_TRUSTED_CONTROLS"],
      [(value) => { value.approvedRevision = "not-a-commit"; }, "INVALID_TRUSTED_CONTROLS"],
      [(value) => { value.controls = null; }, "INVALID_TRUSTED_CONTROLS"],
      [(value) => { value.extra = true; }, "INVALID_TRUSTED_CONTROLS"],
    ]) {
      assert.throws(() => revisionCase(revisionRequest(), [], trustedControls(change)), (error) => error.code === code, code);
    }
  }

  // The shipped CLI routes the same status and refuses untrusted control input.
  {
    const { dir } = makeFixture();
    const requestFile = path.join(dir, "revision-request.json");
    const controlsFile = path.join(dir, "trusted-controls.json");
    const resultFile = path.join(dir, "published-status.json");
    fs.writeFileSync(requestFile, `${JSON.stringify(revisionRequest(), null, 2)}\n`);
    fs.writeFileSync(controlsFile, `${JSON.stringify(trustedControls(), null, 2)}\n`);
    fs.writeFileSync(resultFile, `${JSON.stringify(revisionResult((value) => { value.revision.head = revisionPreviousHead; }), null, 2)}\n`);

    const pending = spawnSync(process.execPath, [cli, "revision", "--request", requestFile], { cwd: root, encoding: "utf8" });
    assert.equal(pending.status, 0, pending.stderr);
    const pendingReport = JSON.parse(pending.stdout);
    assert.equal(pendingReport.status, "pending");
    assert.equal(pendingReport.green, false);
    assert.equal(pendingReport.trustedControls.available, false);

    const stale = spawnSync(process.execPath, [cli, "revision", "--request", requestFile, "--controls", controlsFile, "--result", resultFile], { cwd: root, encoding: "utf8" });
    assert.equal(stale.status, 0, stale.stderr);
    const staleReport = JSON.parse(stale.stdout);
    assert.equal(staleReport.status, "pending");
    assert.equal(staleReport.green, false);
    assert.equal(staleReport.results[0].disposition, "PREVIOUS_HEAD");

    const untrusted = path.join(dir, "candidate-request.json");
    fs.writeFileSync(untrusted, `${JSON.stringify(revisionRequest((value) => { value.controls = revisionControls(); }), null, 2)}\n`);
    const refused = spawnSync(process.execPath, [cli, "revision", "--request", untrusted, "--controls", controlsFile], { cwd: root, encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /UNTRUSTED_CONTROL_SOURCE/u);
    assert.equal(refused.stdout, "");

    for (const args of [
      ["revision"],
      ["revision", "--request"],
      ["revision", "--request", requestFile, "--unknown", controlsFile],
      ["revision", "--request", requestFile, "--request", requestFile],
      ["revision", "--request", requestFile, "--controls", "--result"],
      ["revision", "--controls", controlsFile],
      ["validate", root, "extra", "more"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /usage: node scripts\/skill-evals\.cjs/u, args.join(" "));
    }
    assert.match(spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" }).stderr, /usage: node scripts\/skill-evals\.cjs/u);
    const repeated = spawnSync(process.execPath, [cli, "revision", "--request", requestFile, "--controls", controlsFile, "--result", resultFile, "--result", resultFile], { cwd: root, encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).results.length, 2);
  }

  console.log("Skill eval tests passed.");
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
