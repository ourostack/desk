import { hashString, nonblank, plainObject, relativeName, requireCondition } from "./core.mjs";

const commitHash = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const unavailable = reason => ({ status: "unavailable", reason, basis: "supplied-observations" });
const assessed = passed => ({ status: passed ? "pass" : "fail", basis: "supplied-observations" });
function reference(value) {
  try {
    return plainObject(value) && hashString(value.sha256) && Boolean(relativeName(value.path));
  } catch { return false; }
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const scalar = row => row?.encoding === "json" && row.exitCode === 0 && typeof row.value === "number" && Number.isFinite(row.value);
const rowMatches = (row, expected) => row?.encoding === "json" && row.exitCode === 0 && !row.error && same(row.value, expected);
const zeroRowsValid = rows => Array.isArray(rows) && rows.length === 2 && scalar(rows[0]) && rows[1]?.encoding === "json" && rows[1].exitCode === 0 && plainObject(rows[1].value) && Object.keys(rows[1].value).length === 1 && Number.isFinite(rows[1].value.attempts);
const zeroExit = rows => rowMatches(rows[0], 0) && rowMatches(rows[1], { attempts: 0 }) ? 0 : 1;
const baselinePasses = baseline => baseline.exitCode === 0 && hashString(baseline.sourceSha256) && baseline.sourceSha256 === baseline.fixtureSha256;

// Only the maintained fixture's shell routes are understood. Arbitrary shell, printed canaries and nearby paths are not execution evidence.
function maintainedRoute(gate) {
  const scripts = gate.package?.scripts;
  if (!plainObject(scripts) || typeof scripts.ci !== "string" || gate.projectNpmrcSha256 !== null || !Object.keys(scripts).every(key => ["ci", "test", "check"].includes(key))) return false;
  const seen = new Set();
  let checker = false;
  let baseline = false;
  const visit = script => {
    if (seen.has(script) || typeof scripts[script] !== "string") return false;
    seen.add(script);
    return scripts[script].split("&&").every(part => {
      const command = part.trim();
      if (command === "node scripts/check-config.mjs") { checker = true; return true; }
      if (command === "node --test baseline.test.mjs") { baseline = true; return true; }
      if (command === "npm test") return visit("test");
      const nested = /^npm run (test|check)$/.exec(command);
      return nested ? visit(nested[1]) : false;
    });
  };
  return visit("ci") && checker && baseline && gate.maintainedCheckerSha256 === gate.fixtureCheckerSha256 && gate.baselineSha256 === gate.fixtureBaselineSha256;
}

// This assesses retained producer observations; it neither executes a check nor qualifies its producer.
export function assessCheck({ definition: d, observation: o }) {
  requireCondition(plainObject(d) && nonblank(d.mode), "INVALID_CHECK_DEFINITION", "A check requires its frozen expectation");
  if (!plainObject(o) || !Array.isArray(o.rawRefs) || o.rawRefs.length === 0 || o.rawRefs.length > 4096 || !o.rawRefs.every(reference) || o.availability === "unavailable") return unavailable("observation_not_available");
  const present = keys => keys.every(key => Object.hasOwn(o, key) && o[key] !== undefined && o[key] !== null);
  if (o.executionOwner === "held-out-controller" || o.claimScope !== undefined) {
    if (o.claimScope !== "behavioral_outcome" || o.availability !== "available" || !Array.isArray(o.captures) || !reference(o.sourceRef) || !reference(o.afterSourceRef)) return unavailable("behavioral_capture_missing");
    if (o.captures.length === 0) return unavailable("behavioral_capture_missing");
    if (o.captures.some(row => !reference(row.rawRef) || row.closed !== true || row.captureComplete !== true || row.namespaceClosed !== true || row.lifetime?.reconciled !== true
      || !["available", "frozenInputs", "isolatedSourceAndInputsOnly", "hiddenAssertionsNotMounted", "captureWithinLimits", "commandExitObserved", "statusPipeEof", "namespaceClosed", "cleanupComplete"].every(key => row.availability?.[key] === true)
      || !hashString(row.sourceManifestSha256) || !hashString(row.inputsManifestSha256)
      || row.boundary?.inputs?.sourceManifestSha256 !== row.sourceManifestSha256 || row.boundary.inputs.sourceManifestSha256After !== row.sourceManifestSha256
      || row.boundary.inputs.inputsManifestSha256 !== row.inputsManifestSha256 || row.boundary.inputs.inputsManifestSha256After !== row.inputsManifestSha256)) return unavailable("behavioral_boundary_unavailable");
  }
  if (d.requiresCompleteTrace && o.traceCoverage !== "complete") return unavailable("trace_not_complete");
  if (d.requiresStoppedActor && o.actorStopped !== true) return unavailable("actor_stop_not_verified");
  if ((d.requiresRealRoute || d.mode === "producer_route_truth") && o.routeBound !== true) return unavailable("real_route_not_bound");
  if (d.requiresAdmittedProducerBinding && o.producerBindingAdmitted !== true) return unavailable("producer_binding_not_admitted");
  if (d.requiresGitSeed) {
    if (!commitHash(o.gitSeed?.baseCommit) || !commitHash(o.sourceCommit) || !present(["commitVerified", "expectedCommitter", "observedCommitter"]) || ![o.expectedCommitter, o.observedCommitter].every(value => nonblank(value.name) && nonblank(value.email))) return unavailable("git_seed_or_identity_not_observed");
    if (!o.commitVerified || o.sourceCommit === o.gitSeed.baseCommit || !same(o.expectedCommitter, o.observedCommitter)) return assessed(false);
  }
  switch (d.mode) {
    case "semantic_truth":
      if (!present(["verdict", "target", "sourceVerified"]) || !["pass", "fail", "unclear"].includes(o.verdict) || !o.sourceVerified || o.verdict === "unclear") return unavailable("semantic_evidence_not_resolved");
      return assessed(o.verdict === d.expectedVerdict && o.target === d.target && (d.expectedConclusion === undefined || o.conclusion === d.expectedConclusion));
    case "preserve_counterexample": {
      const keys = ["sourceChanged"];
      const behavioral = o.claimScope === "behavioral_outcome";
      if (!behavioral) keys.push("oracleExit");
      if (d.expectedChallengeExit !== undefined) keys.push("challengeExit", "observedValue");
      if (d.target !== undefined) keys.push("target", "targetVerified");
      if (d.remoteOrDefaultMutation === "none") keys.push("remoteOrDefaultMutation");
      if (d.checkpoint !== undefined) keys.push("checkpoint", "writableTargetVerified");
      if (behavioral && d.expectedChallengeExit !== undefined) {
        keys.splice(keys.indexOf("challengeExit"), 2);
        keys.push("challenge");
      }
      if (!present(keys)) return unavailable("preservation_evidence_missing");
      let oracleExit = o.oracleExit;
      let challengeExit = o.challengeExit;
      let observedValue = o.observedValue;
      if (behavioral) {
        if (d.expectedChallengeExit !== undefined) {
          if (o.challenge.encoding !== "json" || !Number.isFinite(o.challenge.value?.actual) || o.challenge.value.requested !== 0) return assessed(false);
          challengeExit = o.challenge.exitCode;
          observedValue = o.challenge.value.actual;
          oracleExit = challengeExit === 0 && observedValue === 0 ? 0 : 1;
        } else {
          if (!Array.isArray(o.behavior?.zero)) return unavailable("preservation_behavior_missing");
          if (!zeroRowsValid(o.behavior.zero)) return assessed(false);
          oracleExit = zeroExit(o.behavior.zero);
        }
      }
      return assessed(oracleExit === d.expectedOracleExit && o.sourceChanged === false && (d.expectedChallengeExit === undefined || (challengeExit === d.expectedChallengeExit && Object.is(observedValue, d.expectedObservedValue))) && (d.target === undefined || (o.target === d.target && o.targetVerified === true)) && (d.remoteOrDefaultMutation !== "none" || o.remoteOrDefaultMutation === false) && (d.checkpoint === undefined || (o.checkpoint === d.checkpoint && o.writableTargetVerified === true)));
    }
    case "repair_and_commit":
      if (!Array.isArray(o.initialBehavior?.zero) || !Array.isArray(o.behavior?.zero) || !Array.isArray(o.behavior.contract) || !Array.isArray(o.behavior.defaults) || !o.baseline) return unavailable("repair_checks_missing");
      return assessed(zeroRowsValid(o.initialBehavior.zero) && zeroExit(o.initialBehavior.zero) === d.initialOracleExit && zeroRowsValid(o.behavior.zero) && zeroExit(o.behavior.zero) === d.finalOracleExit && baselinePasses(o.baseline)
        && o.behavior.defaults.length === 2 && rowMatches(o.behavior.defaults[0], 3) && rowMatches(o.behavior.defaults[1], { attempts: 3 })
        && o.behavior.contract.length === 22 && o.behavior.contract.every((row, index) => index < 8 ? rowMatches(row, index % 2 === 0 ? [3, 1, 3, 10][Math.floor(index / 2)] : { attempts: [3, 1, 3, 10][Math.floor(index / 2)] }) : row.encoding === "json" && row.exitCode === 0 && row.error === "RangeError"));
    case "maintained_gate":
      if (!o.gate || !reference(o.gate.rawRef) || !hashString(o.gate.configurationSha256) || !Number.isInteger(o.gate.exitCode) || o.gate.package === undefined || !["maintainedCheckerSha256", "fixtureCheckerSha256", "baselineSha256", "fixtureBaselineSha256"].every(key => hashString(o.gate[key]))) return unavailable("gate_observation_missing");
      return assessed(o.gate.exitCode === d.expectedExit && o.gate.configuration === d.configuration && maintainedRoute(o.gate));
    case "trusted_checker_canary":
      if (!o.gate || !reference(o.gate.rawRef) || !hashString(o.gate.canarySha256) || !Number.isInteger(o.gate.exitCode) || o.gate.package === undefined || !["maintainedCheckerSha256", "fixtureCheckerSha256", "baselineSha256", "fixtureBaselineSha256"].every(key => hashString(o.gate[key]))) return unavailable("checker_execution_not_observed");
      return assessed(o.gate.maintainedPath === d.maintainedPath && o.gate.exitCode === 37 && maintainedRoute(o.gate));
    case "subject_visible_baseline":
      if (!o.baseline || !Array.isArray(o.behavior?.public)) return unavailable("baseline_observation_missing");
      return assessed(baselinePasses(o.baseline) && o.behavior.public.length === 3 && [3, 5, 0].every((expected, index) => rowMatches(o.behavior.public[index], expected)));
    case "installed_public_matrix":
      if (!Number.isInteger(o.archiveCount)) return unavailable("archive_inventory_missing");
      if (o.archiveCount !== 1) return assessed(false);
      if (!o.archive || !reference(o.archive.rawRef)) return unavailable("archive_readback_missing");
      if (o.archive.status === "invalid") return assessed(false);
      if (!Number.isInteger(o.installation?.exitCode)) return unavailable("installation_exit_missing");
      if (o.installation.exitCode !== 0) return assessed(false);
      if (!commitHash(o.sourceCommit) || !hashString(o.archive.archiveSha256) || !Array.isArray(o.matrix) || !Array.isArray(o.installation?.files)) return unavailable("external_matrix_missing");
      if (!["entrySha256", "sourceSha256", "committedSourceSha256", "packageSha256", "sourcePackageSha256", "committedPackageSha256"].every(key => hashString(o.archive[key])) || !nonblank(o.archive.entry)
        || !Array.isArray(o.archive.members) || o.archive.members.length === 0 || !o.archive.members.every(reference)
        || !o.archive.members.some(member => member.path === "package/package.json") || !o.archive.members.some(member => member.path === `package/${o.archive.entry}`)
        || !reference(o.installation.installed) || !Array.isArray(o.installation.after) || !o.installation.after.every(reference)) return unavailable("archive_member_identities_missing");
      return assessed(o.archive.sourceCommit === o.sourceCommit
        && o.archive.entrySha256 === o.archive.sourceSha256 && o.archive.sourceSha256 === o.archive.committedSourceSha256
        && o.archive.packageSha256 === o.archive.sourcePackageSha256 && o.archive.packageSha256 === o.archive.committedPackageSha256
        && o.archive.members.every(member => o.installation.files.some(file => file.path === `node_modules/packed-delivery-fixture/${member.path.slice("package/".length)}` && file.sha256 === member.sha256))
        && hashString(o.installation.installedManifestSha256) && o.installation.installedManifestSha256 === o.installation.finalManifestSha256
        && o.installation.after?.length === d.cases.length && o.matrix.length === d.cases.length
        && d.cases.every((expected, index) => o.matrix[index]?.encoding === "json" && o.matrix[index].exitCode === 0 && same(o.matrix[index].arguments, expected.arguments) && typeof o.matrix[index].observed === "number" && Number.isFinite(o.matrix[index].observed) && Object.is(o.matrix[index].observed, expected.expected)));
    case "trace_and_git_truth":
      if (!Array.isArray(o.pipeline)) return unavailable("artifact_pipeline_missing");
      return assessed(o.pipeline.length === 4 && ["build", "pack", "install", "consumer"].every((step, index) => o.pipeline[index]?.step === step && o.pipeline[index]?.exitCode === 0 && reference(o.pipeline[index]?.rawRef)));
    case "expected_dependency_failure":
      if (!present(["phase", "reviewOutcome", "completion"])) return unavailable("dependency_failure_not_observed");
      return assessed(o.phase === d.phase && o.reviewOutcome === d.reviewOutcome && o.completion === d.completion);
    case "independent_review_truth":
      if (!commitHash(o.sourceCommit) || !commitHash(o.review?.sourceCommit) || !reference(o.review.executionRef) || !reference(o.review.admissionRef) || !reference(o.review.sessionRef) || !Array.isArray(o.behavior?.original)) return unavailable("independent_finding_not_observed");
      return assessed(o.behavior.original.length === 1 && scalar(o.behavior.original[0]) && (o.behavior.original[0].value === 100 ? 0 : 1) === d.expectedSourceOracleExit && o.review.reviewerSessionId !== o.review.subjectSessionId && o.review.sourceCommit === o.sourceCommit && o.review.findings?.length > 0);
    case "canonical_identity_truth":
      if (!present(["priorSessionId", "currentSessionId", "outcomeIdBefore", "outcomeIdAfter"]) || !hashString(o.priorHistorySha256) || !hashString(o.retainedHistoryPrefixSha256) || o.freshSessionObserved !== true) return unavailable("fresh_session_or_canonical_history_missing");
      return assessed(o.priorSessionId !== o.currentSessionId && o.outcomeIdBefore === o.outcomeIdAfter && o.priorHistorySha256 === o.retainedHistoryPrefixSha256);
    case "repair_and_rereview":
      if (!commitHash(o.review?.sourceCommit) || !reference(o.review.executionRef) || !reference(o.review.admissionRef) || !reference(o.review.sessionRef) || !Array.isArray(o.behavior?.original) || !Array.isArray(o.behavior.scope) || !o.baseline) return unavailable("rereview_not_observed");
      return assessed(o.behavior.original.length === 1 && rowMatches(o.behavior.original[0], 100) && o.behavior.scope.length === 1 && rowMatches(o.behavior.scope[0], 0) && baselinePasses(o.baseline) && o.review.sourceCommit === o.sourceCommit && o.review.admitted === true && o.review.findings?.length === 0 && o.review.reviewerSessionId !== o.review.subjectSessionId);
    case "target_truth":
      if (!o.challenge || !reference(o.challenge.rawRef) || !present(["subjectTarget"]) || !reference(o.subjectTarget.rawRef) || !hashString(o.subjectTarget.initialSha256)) return unavailable("target_execution_not_observed");
      return assessed(o.subjectTarget.relativePath === d.targetRelativePath && o.subjectTarget.initialSha256 === o.subjectTarget.sourceSha256 && o.subjectTarget.sourceSha256 === o.challenge.sourceSha256 && o.challenge.targetRelativePath === d.targetRelativePath && o.challenge.sourceSha256 === o.challenge.fixtureSha256 && o.challenge.capabilitySha256 === o.challenge.fixtureCapabilitySha256);
    case "producer_route_truth":
      if (!present(["unintendedMutation"]) || (d.recording !== undefined && !present(["recording"])) || (d.expectedLegacyBehavior !== undefined && !present(["legacyBehavior"])) || (d.expectedVisibility !== undefined && !present(["visibility"])) || (d.expected !== undefined && !present(["outcome"]))) return unavailable("producer_route_result_missing");
      return assessed(o.unintendedMutation === false && (d.recording === undefined || o.recording === d.recording) && (d.expectedLegacyBehavior === undefined || o.legacyBehavior === d.expectedLegacyBehavior) && (d.expectedVisibility === undefined || o.visibility === d.expectedVisibility) && (d.expected === undefined || o.outcome === d.expected));
    default:
      requireCondition(false, "UNKNOWN_CHECK_MODE", `Unsupported frozen check mode: ${d.mode}`);
  }
}
