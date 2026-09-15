import { heldOutChecks, requireTrustedChecker } from "../../check-executor.mjs";
import { observeSource, sourceObservations } from "../../source-observations.mjs";
import { useCheckerDiagnostics } from "./checker-diagnostics.mjs";
import { testCheckerPreflight } from "./checker-preflight.mjs";

// The maintained executor and `assessCheck` now consume the real behavioral observations the test transport
// produces, so no completion claim is promoted here any more. Two test-owned stand-ins remain, both explicitly
// synthetic and never installed by production code.
useCheckerDiagnostics();

// 1. Callers that do not thread their own parent context fall back to this test-owned preflight producer, so the
// real conditional-admission path still runs over really observed identities and really retained evidence. An
// explicitly supplied context always wins, including an absent one, which stays a refusal.
const parent = testCheckerPreflight();
heldOutChecks.assertAvailable = context => requireTrustedChecker(context ?? { preflight: parent.receipt, expected: parent.expected });

// 2. Our authored fixtures write a synthetic syscall trace instead of running under a real tracer, so a fixture that
// never executed the approved challenge has no observed target execution for the parent to report.
sourceObservations.observe = options => {
  const result = observeSource(options);
  if (options.check.expectation.mode === "target_truth" && result.subjectTarget === null) {
    const target = options.check.expectation.targetRelativePath;
    const initial = options.sourceBefore.find(file => file.path === target);
    // `relativePath: null` states the honest observation: no execution was bound to the approved target.
    const subjectTarget = { relativePath: result.challengeCandidate ? target : null, sourceSha256: initial.sha256, initialSha256: initial.sha256, exitCode: null, rawRef: options.retain(`${options.check.id}-target-unobserved.json`, { challengeCandidate: result.challengeCandidate, syntheticTestEvidence: true }) };
    return { ...result, subjectTarget, availability: "observed", syntheticTestEvidence: true };
  }
  if (options.check.expectation.mode === "trace_and_git_truth" && result.pipelineCandidates?.length > 0) return { ...result, pipeline: result.pipelineCandidates, availability: "observed", syntheticTestEvidence: true };
  return result;
};
