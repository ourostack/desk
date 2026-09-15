import path from "node:path";
import { checkerProcess } from "../../checker-process.mjs";
import { canonicalJson, listRegularFiles, overlaps, sha256 } from "../../core.mjs";
import { captureBoundedCommand } from "../../output.mjs";

// Test-process-only transport for our authored fixtures. It runs the command as an ordinary child of this test
// process: there is no bubblewrap launcher, no namespace, no mount and no OS boundary of any kind. It reports the
// boundary-shaped fields the maintained executor consumes so the controller's downstream protocol can be exercised,
// and every one of those fields is asserted from this process's own observations, never from a kernel. It is not
// native admission and is never installed by production code; `checker-process.test.mjs` exercises the real
// `captureConfinedChecker`, and the qualified receipt comes from `qualifyCheckerBoundary` under the Linux boundary.
const manifestHash = root => sha256(Buffer.from(canonicalJson(listRegularFiles(root))));

export function useCheckerDiagnostics() {
  const original = checkerProcess.capture;
  checkerProcess.capture = async ({ workRoot, subject, checkerRoot, inputsRoot, scratchRoot, ...request }) => {
    const before = { source: manifestHash(subject), inputs: manifestHash(inputsRoot) };
    const result = await captureBoundedCommand(request);
    const after = { source: manifestHash(subject), inputs: manifestHash(inputsRoot) };
    const readOnly = [path.dirname(path.dirname(process.execPath)), subject, inputsRoot];
    const cleanupComplete = result.cleanup.unverifiedPids.length === 0 && result.cleanup.ownedSpawns.length > 0 && result.cleanup.exitObservations.length === result.cleanup.ownedSpawns.length;
    const facts = {
      frozenInputs: before.source === after.source && before.inputs === after.inputs,
      isolatedSourceAndInputsOnly: true,
      hiddenAssertionsNotMounted: [...readOnly, scratchRoot].every(root => !overlaps(root, checkerRoot)) && ![...readOnly, scratchRoot].includes(workRoot),
      captureWithinLimits: ![result.stdout, result.stderr].some(channel => channel.truncated) && !["COMMAND_OUTPUT_OVERFLOW", "COMMAND_CAPTURE_OVERFLOW"].includes(result.failure?.code),
      commandExitObserved: result.status === "exited" && Number.isInteger(result.exitCode) && result.signal === null,
      statusPipeEof: true,
      namespaceClosed: result.status === "exited" && result.signal === null && result.captureComplete === true,
      cleanupComplete,
    };
    return {
      ...result,
      statusPipeEof: facts.statusPipeEof, namespaceClosed: facts.namespaceClosed,
      lifetime: { reconciled: cleanupComplete, scope: "test-process-child-only" },
      boundary: {
        readOnly, writable: [scratchRoot], hiddenRoots: [checkerRoot, workRoot], chdir: request.cwd,
        inputs: { sourceManifestSha256: before.source, sourceManifestSha256After: after.source, inputsManifestSha256: before.inputs, inputsManifestSha256After: after.inputs },
      },
      availability: { ...facts, available: Object.values(facts).every(Boolean), scope: "test-transport-observations-not-an-os-boundary", syntheticTestEvidence: true },
    };
  };
  return () => { checkerProcess.capture = original; };
}
