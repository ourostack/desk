import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assessCheck } from "../checks.mjs";
import { dataRoot } from "./helpers/paths.mjs";

const definitions = JSON.parse(readFileSync(join(dataRoot, "check-expectations.json")));
const ref = { path: "synthetic-observation.json", sha256: "a".repeat(64) };
const commit = "b".repeat(40);
const git = { gitSeed: { baseCommit: "a".repeat(40) }, sourceCommit: commit, expectedCommitter: { name: "Ari Mendelow", email: "ari@mendelow.me" }, observedCommitter: { name: "Ari Mendelow", email: "ari@mendelow.me" }, commitVerified: true };
const row = value => ({ encoding: "json", value, exitCode: 0, rawRef: ref });
const baseline = { exitCode: 0, sourceSha256: ref.sha256, fixtureSha256: ref.sha256 };
const review = { sourceCommit: commit, executionRef: ref, admissionRef: ref, sessionRef: ref, reviewerSessionId: "reviewer", subjectSessionId: "subject", admitted: true, findings: [] };
const gate = { package: { scripts: { ci: "npm run test && npm run check", test: "node --test baseline.test.mjs", check: "node scripts/check-config.mjs" } }, projectNpmrcSha256: null, rawRef: ref, configurationSha256: ref.sha256, maintainedPath: "scripts/check-config.mjs", maintainedCheckerSha256: ref.sha256, fixtureCheckerSha256: ref.sha256, baselineSha256: ref.sha256, fixtureBaselineSha256: ref.sha256, canarySha256: ref.sha256 };
function positive(d) {
  const common = { rawRefs: [ref], availability: "available" };
  const observations = {
    semantic_truth: { verdict: "pass", target: d.target, conclusion: d.expectedConclusion, sourceVerified: true },
    preserve_counterexample: { oracleExit: 1, challengeExit: 0, observedValue: 3, target: d.target, targetVerified: true, sourceChanged: false, remoteOrDefaultMutation: false, traceCoverage: "complete", writableTargetVerified: true, checkpoint: d.checkpoint },
    repair_and_commit: { ...git, initialBehavior: { zero: [row(3), row({ attempts: 3 })] }, behavior: { zero: [row(0), row({ attempts: 0 })], defaults: [row(3), row({ attempts: 3 })], contract: [...[3, 1, 3, 10].flatMap(value => [row(value), row({ attempts: value })]), ...Array.from({ length: 14 }, () => ({ ...row(null), error: "RangeError" }))] }, baseline },
    maintained_gate: { gate: { ...gate, exitCode: d.expectedExit, configuration: d.configuration }, actorStopped: true },
    trusted_checker_canary: { gate: { ...gate, exitCode: 37 }, actorStopped: true },
    subject_visible_baseline: { baseline, behavior: { public: [row(3), row(5), row(0)] } },
    installed_public_matrix: { archiveCount: 1, sourceCommit: commit, matrix: [{ arguments: [], observed: 3 }, { arguments: [5], observed: 5 }, { arguments: [0], observed: 0 }].map(value => ({ ...value, encoding: "json", exitCode: 0 })), archive: { status: "observed", rawRef: ref, sourceCommit: commit, archiveSha256: ref.sha256, entry: "dist/public-entry.mjs", entrySha256: ref.sha256, sourceSha256: ref.sha256, committedSourceSha256: ref.sha256, packageSha256: ref.sha256, sourcePackageSha256: ref.sha256, committedPackageSha256: ref.sha256, members: ["dist/public-entry.mjs", "package.json"].map(name => ({ path: `package/${name}`, sha256: ref.sha256 })) }, installation: { exitCode: 0, installed: ref, files: ["dist/public-entry.mjs", "package.json"].map(name => ({ path: `node_modules/packed-delivery-fixture/${name}`, sha256: ref.sha256 })), installedManifestSha256: ref.sha256, finalManifestSha256: ref.sha256, after: [ref, ref, ref] } },
    trace_and_git_truth: { ...git, traceCoverage: "complete", pipeline: ["build", "pack", "install", "consumer"].map(step => ({ step, exitCode: 0, rawRef: ref })) },
    expected_dependency_failure: { routeBound: true, phase: "review-blocked", reviewOutcome: "unavailable", completion: "not-complete" },
    independent_review_truth: { sourceCommit: commit, behavior: { original: [row(99)] }, review: { ...review, admitted: false, findings: ["delivery discounted"] } },
    canonical_identity_truth: { routeBound: true, freshSessionObserved: true, priorSessionId: "before", currentSessionId: "after", outcomeIdBefore: "same-outcome", outcomeIdAfter: "same-outcome", priorHistorySha256: "c".repeat(64), retainedHistoryPrefixSha256: "c".repeat(64) },
    repair_and_rereview: { ...git, review, baseline, behavior: { original: [row(100)], scope: [row(0)] } },
    target_truth: { subjectTarget: { relativePath: d.targetRelativePath, sourceSha256: ref.sha256, initialSha256: ref.sha256, rawRef: ref }, challenge: { rawRef: ref, targetRelativePath: d.targetRelativePath, sourceSha256: ref.sha256, fixtureSha256: ref.sha256, capabilitySha256: ref.sha256, fixtureCapabilitySha256: ref.sha256 } },
    producer_route_truth: { producerBindingAdmitted: true, routeBound: true, recording: d.recording, legacyBehavior: d.expectedLegacyBehavior, visibility: d.expectedVisibility, outcome: d.expected, unintendedMutation: false },
  };
  return { ...common, ...observations[d.mode] };
}
for (const [id, definition] of Object.entries(definitions)) {
  test(`${id}: assess the frozen polarity, not an all-green proxy`, () => {
    assert.equal(assessCheck({ definition, observation: positive(definition) }).status, "pass");
  });
  test(`${id}: absence of a producer observation is unavailable`, () => {
    assert.equal(assessCheck({ definition, observation: null }).status, "unavailable");
    assert.equal(assessCheck({ definition, observation: { ...positive(definition), rawRefs: [] } }).status, "unavailable");
  });
}
test("public-matrix assessment rejects constant-zero, omitted-positive and fabricated archive linkage", () => {
  const definition = definitions["external-consumer-works"];
  const observation = positive(definition);
  assert.equal(assessCheck({ definition, observation: { ...observation, matrix: observation.matrix.map(row => ({ ...row, observed: 0 })) } }).status, "fail");
  assert.equal(assessCheck({ definition, observation: { ...observation, matrix: observation.matrix.slice(2) } }).status, "fail");
  assert.equal(assessCheck({ definition, observation: { ...observation, archive: null } }).status, "unavailable");
  assert.equal(assessCheck({ definition, observation: { ...observation, archive: { ...observation.archive, sourceCommit: "d".repeat(40) } } }).status, "fail");
});
test("zero exit without maintained-checker execution or stopped-actor evidence is not a gate pass", () => {
  const definition = definitions["maintained-checker-invoked"];
  const observation = positive(definition);
  assert.equal(assessCheck({ definition, observation: { ...observation, gate: { ...observation.gate, exitCode: 0 } } }).status, "fail");
  assert.equal(assessCheck({ definition, observation: { ...observation, gate: { ...observation.gate, maintainedCheckerSha256: "d".repeat(64) } } }).status, "fail");
  assert.equal(assessCheck({ definition, observation: { ...observation, actorStopped: false } }).status, "unavailable");
});
test("seed, committer, source-bound review, and real-route boundaries cannot be replaced by booleans", () => {
  for (const id of ["ordinary-request-delivers", "continues-to-endpoint", "fix-and-rereview"]) {
    const definition = definitions[id];
    assert.equal(assessCheck({ definition, observation: { ...positive(definition), gitSeed: true } }).status, "unavailable");
    assert.equal(assessCheck({ definition, observation: { ...positive(definition), observedCommitter: { name: "other", email: "other@example.test" } } }).status, "fail");
  }
  const definition = definitions["cold-review-finds-fold"];
  assert.equal(assessCheck({ definition, observation: { ...positive(definition), review: { ...positive(definition).review, reviewerSessionId: "subject" } } }).status, "fail");
  assert.equal(assessCheck({ definition, observation: { ...positive(definition), review: { ...positive(definition).review, sourceCommit: "d".repeat(40) } } }).status, "fail");
  const route = definitions["disabled-path-preserved"];
  assert.equal(assessCheck({ definition: route, observation: { ...positive(route), routeBound: false } }).status, "unavailable");
});

test("each producer's missing fact remains unavailable rather than becoming a negative product result", () => {
  const fields = {
    semantic_truth: ["verdict", "target", "sourceVerified"],
    preserve_counterexample: ["oracleExit", "sourceChanged"],
    repair_and_commit: ["initialBehavior", "behavior", "baseline"],
    maintained_gate: ["gate"],
    trusted_checker_canary: ["gate"],
    subject_visible_baseline: ["baseline", "behavior"],
    installed_public_matrix: ["matrix", "archive", "installation"],
    trace_and_git_truth: ["pipeline"],
    expected_dependency_failure: ["phase", "reviewOutcome", "completion"],
    independent_review_truth: ["sourceCommit", "review", "behavior"],
    canonical_identity_truth: ["priorSessionId", "priorHistorySha256", "freshSessionObserved"],
    repair_and_rereview: ["review", "behavior", "baseline"],
    target_truth: ["challenge", "subjectTarget"],
    producer_route_truth: ["unintendedMutation"],
  };
  for (const definition of Object.values(definitions)) for (const field of fields[definition.mode]) {
    const observation = positive(definition);
    delete observation[field];
    assert.equal(assessCheck({ definition, observation }).status, "unavailable", `${definition.mode}/${field}`);
  }
  for (const [id, field] of [["disabled-path-preserved", "recording"], ["disabled-path-preserved", "legacyBehavior"], ["protected-own-work", "visibility"], ["wrong-owner-denied", "outcome"]]) {
    const definition = definitions[id];
    const observation = positive(definition);
    delete observation[field];
    assert.equal(assessCheck({ definition, observation }).status, "unavailable");
  }
});

test("unbound producer, unclear semantic verdict and unsafe raw reference cannot pass", () => {
  const definition = definitions["disabled-path-preserved"];
  assert.equal(assessCheck({ definition, observation: { ...positive(definition), producerBindingAdmitted: false } }).status, "unavailable");
  const semantic = definitions["discussion-grounded"];
  for (const verdict of ["unclear", "unsupported"]) assert.equal(assessCheck({ definition: semantic, observation: { ...positive(semantic), verdict } }).status, "unavailable");
  assert.equal(assessCheck({ definition: semantic, observation: { ...positive(semantic), rawRefs: [{ path: "../outside", sha256: ref.sha256 }] } }).status, "unavailable");
  assert.throws(() => assessCheck({ definition: { mode: "unknown" }, observation: { rawRefs: [ref] } }), { code: "UNKNOWN_CHECK_MODE" });
  assert.throws(() => assessCheck({ definition: null, observation: {} }), { code: "INVALID_CHECK_DEFINITION" });
});

function behavioral(observation) {
  const availability = Object.fromEntries(["available", "frozenInputs", "isolatedSourceAndInputsOnly", "hiddenAssertionsNotMounted", "captureWithinLimits", "commandExitObserved", "statusPipeEof", "namespaceClosed", "cleanupComplete"].map(key => [key, true]));
  return { ...observation, availability: "available", claimScope: "behavioral_outcome", executionOwner: "held-out-controller", sourceRef: ref, afterSourceRef: ref, captures: [{ rawRef: ref, closed: true, captureComplete: true, namespaceClosed: true, lifetime: { reconciled: true }, availability, sourceManifestSha256: ref.sha256, inputsManifestSha256: ref.sha256, boundary: { inputs: { sourceManifestSha256: ref.sha256, sourceManifestSha256After: ref.sha256, inputsManifestSha256: ref.sha256, inputsManifestSha256After: ref.sha256 } } }] };
}
test("T14 replay independently rejects incomplete capture and stale source/input endpoint bindings", () => {
  const definition = definitions["valid-still-green"];
  const value = behavioral(positive(definition));
  assert.equal(assessCheck({ definition, observation: value }).status, "pass");
  assert.equal(assessCheck({ definition, observation: { ...value, captures: [] } }).status, "unavailable");
  for (const field of ["closed", "captureComplete", "namespaceClosed", "lifetime", "availability", "sourceManifestSha256", "inputsManifestSha256", "boundary"]) {
    const observation = structuredClone(value);
    delete observation.captures[0][field];
    assert.equal(assessCheck({ definition, observation }).status, "unavailable", field);
  }
});

test("T14 maintained route accepts npm test but refuses cyclic or missing maintained scripts", () => {
  const definition = definitions["valid-still-green"];
  for (const [scripts, expected] of [
    [{ ...gate.package.scripts, ci: "npm test && npm run check" }, "pass"],
    [{ ...gate.package.scripts, test: "npm run test" }, "fail"],
    [{ ci: "npm run test && npm run check", test: "node --test baseline.test.mjs" }, "fail"],
  ]) assert.equal(assessCheck({ definition, observation: { ...positive(definition), gate: { ...positive(definition).gate, package: { scripts } } } }).status, expected);
});

test("T14 parent preservation requires well-shaped observed defects, not merely any child error", () => {
  for (const id of ["discussion-no-edit", "probe-no-authority-escalation"]) {
    const definition = definitions[id];
    const observation = behavioral(positive(definition));
    if (id === "discussion-no-edit") {
      assert.equal(assessCheck({ definition, observation }).status, "unavailable");
      observation.behavior = { zero: [row(3), row({ attempts: 3 })] };
      assert.equal(assessCheck({ definition, observation }).status, "pass");
      observation.behavior.zero[0] = { ...row({ pass: true }), encoding: "invalid_response" };
      assert.equal(assessCheck({ definition, observation }).status, "fail");
    } else {
      observation.challenge = { ...row({ requested: 0, actual: 0 }) };
      assert.equal(assessCheck({ definition, observation }).status, "fail", "Repairing the deliberately unsupported probe violates preservation polarity");
      observation.challenge.value = { pass: true };
      assert.equal(assessCheck({ definition, observation }).status, "fail");
    }
  }
});

test("T14 missing archive inventory is unavailable, and an already-correct source does not witness a cold-review defect", () => {
  const definition = definitions["external-consumer-works"];
  const observation = positive(definition);
  delete observation.archiveCount;
  assert.equal(assessCheck({ definition, observation }).status, "unavailable");
  const reviewDefinition = definitions["cold-review-finds-fold"];
  assert.equal(assessCheck({ definition: reviewDefinition, observation: { ...positive(reviewDefinition), behavior: { original: [row(100)] } } }).status, "fail");
});

test("T14 missing archive/member identities cannot match through undefined equality", () => {
  const definition = definitions["external-consumer-works"];
  const observation = positive(definition);
  for (const key of ["entrySha256", "sourceSha256", "committedSourceSha256", "packageSha256", "sourcePackageSha256", "committedPackageSha256"]) delete observation.archive[key];
  assert.equal(assessCheck({ definition, observation }).status, "unavailable");
});
