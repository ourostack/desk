import fs from "node:fs";
import path from "node:path";
import { canonicalJson, jsonBytes, listRegularFiles, readRegular, sha256 } from "../../core.mjs";
import { workRoot } from "./paths.mjs";

// Test-owned preflight producer. Every digest here is observed from bytes this test process really wrote or really
// read — the running runtime, a real launcher stand-in file, and two real manifest roots — so admission consumes
// observed identities rather than literals. It is explicitly a test transport and is not native qualification:
// the qualified receipt comes from `qualifyCheckerBoundary` running under the registered Linux checker boundary.
let sequence = 0;
const manifestDigest = root => sha256(Buffer.from(canonicalJson(listRegularFiles(root))));
function fileDigest(filename) {
  return sha256(fs.readFileSync(filename));
}

export function testCheckerPreflight() {
  const root = workRoot(`checker-preflight-${++sequence}`);
  const source = path.join(root, "source");
  const controller = path.join(root, "controller");
  const evidence = path.join(root, "evidence");
  for (const directory of [source, controller, evidence]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, "delivered.mjs"), "export const retryAttempts = value => value ?? 3;\n", { mode: 0o600 });
  fs.writeFileSync(path.join(controller, "oracle.test.mjs"), "// held-out assertions the candidate never reads\n", { mode: 0o600 });
  const launcher = path.join(root, "launcher-identity.bin");
  fs.writeFileSync(launcher, Buffer.from("synthetic launcher identity bytes, never executed\n"), { mode: 0o400 });
  const observe = () => ({
    controllerSha256: manifestDigest(controller),
    runtimeSha256: fileDigest(process.execPath),
    launcherSha256: fileDigest(launcher),
    sourceManifestSha256: manifestDigest(source),
  });
  const probes = ["hidden-read", "write-denied", "network-denied", "fork-setsid", "capture-bound", "cancellation"];
  const evidenceRefs = [];
  const retain = (name, bytes) => {
    fs.writeFileSync(path.join(evidence, name), bytes, { flag: "w", mode: 0o600 });
    evidenceRefs.push({ path: name, sha256: sha256(bytes) });
  };
  for (const probe of probes) {
    retain(`${probe}-status.raw`, Buffer.from(`{"child-pid":4242,"probe":"${probe}"}\n`));
    retain(`${probe}-probe.json`, jsonBytes({ id: probe, accepted: true, started: true, cleanupReconciled: true, statusPipeEof: true, namespaceClosed: true }));
  }
  const receipt = {
    schemaVersion: 1, status: "available", claimScope: "behavioral_outcome",
    identities: observe(),
    checks: { isolation: true, hiddenAssertionsSeparated: true, boundedCapture: true, namespaceCleanup: true, frozenIdentities: true },
    evidenceRefs,
  };
  // `observeIdentities` is re-read at every admission boundary, so a mid-run source/controller/launcher change refuses.
  const expected = { identities: observe(), observeIdentities: observe, readEvidence: name => readRegular(evidence, name).bytes };
  // Mutators return a fresh receipt/expected pair so a negative never edits the retained positive control.
  return {
    root, source, controller, evidence, launcher, receipt, expected, observe,
    truncate: name => fs.writeFileSync(path.join(evidence, name), Buffer.alloc(0), { flag: "w", mode: 0o600 }),
    remove: name => fs.rmSync(path.join(evidence, name)),
    mutateSource: () => fs.writeFileSync(path.join(source, "delivered.mjs"), "export const retryAttempts = value => value || 3;\n", { flag: "w", mode: 0o600 }),
    mutateController: () => fs.writeFileSync(path.join(controller, "oracle.test.mjs"), "// changed held-out assertions\n", { flag: "w", mode: 0o600 }),
    mutateLauncher: () => { fs.chmodSync(launcher, 0o600); fs.writeFileSync(launcher, Buffer.from("replaced launcher bytes\n"), { flag: "w", mode: 0o600 }); },
  };
}
