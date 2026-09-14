import { jsonBytes, sha256 } from "../../core.mjs";

// Synthetic generation-bound observations for source tests, not kernel evidence.
export function ownerCleanup(runId) {
  const artifacts = new Map();
  const identity = { pid: 4242, spawnIdentity: `${runId}:4242` };
  const row = type => {
    const terminal = type === "exit" ? { exited: true, exitCode: 0, signal: null } : {};
    const bytes = jsonBytes({ type, runId, ...identity, ...terminal, synthetic: true });
    const name = `${type}.json`;
    artifacts.set(name, bytes);
    return { ...identity, ...terminal, rawRef: { path: name, sha256: sha256(bytes), byteLength: bytes.length } };
  };
  return {
    runId,
    receipt: { runId, completedWithinBudget: true, unverifiedPids: [], ownedSpawns: [row("spawn")], exitObservations: [row("exit")] },
    readArtifact: name => artifacts.get(name),
    artifacts,
  };
}
