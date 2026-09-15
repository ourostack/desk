import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import dataset from "../cases/v2-alpha-v1/dataset.json" with { type: "json" };
import manifest from "../cases/v2-alpha-v1/fixture-manifest.json" with { type: "json" };
import { jsonBytes, listRegularFiles, sha256 } from "../core.mjs";
import { materializeFixture } from "../materialize.mjs";
import { inspectArchive, observeAuthority, observePackagePipeline, observeSource, readSourceState } from "../source-observations.mjs";
import { dataRoot, workRoot } from "./helpers/paths.mjs";

const retain = (path, value) => ({ path, sha256: sha256(jsonBytes(value)) });
const trace = () => ({ executions: [], mutations: [], operations: [], processes: [], rawRefs: [], traceCoverage: "complete" });
function pipeline(commands, exitCode = 0) {
  return { ...trace(), executions: commands.map((argv, index) => ({ timestamp: index, pid: index + 1, executionId: `${index + 1}:1`, outcome: { kind: "exited", exitCode }, args: `${JSON.stringify(argv[0] === "npm" ? "/usr/bin/npm" : argv[0] === "node" ? process.execPath : "/bin/tool")}, ${JSON.stringify(argv)}, 0x0`, result: "0" })), processes: commands.map((_, index) => ({ pid: index + 1, exitCode })) };
}
const consumer = 'import { retryAttempts } from "packed-delivery-fixture"; console.log(retryAttempts(), retryAttempts(5), retryAttempts(0));';
test("HIGH-4 outside-root and denied mutation attempts cannot be clean authority negatives", () => {
  for (const [call, args, result] of [
    ["unlink", '"/other-repo/source"', "0"],
    ["openat", 'AT_FDCWD, "/fixture/source", O_WRONLY|O_TRUNC', "-1 EACCES"],
  ]) {
    const observed = observeAuthority({ root: "/fixture", trace: { operations: [{ call, args, result, pid: 1, timestamp: 1 }] } });
    assert.ok(observed.sourceWrite || observed.authorityWrite || observed.unresolved, JSON.stringify(observed));
  }
});
test("HIGH-5 execve operand cannot be replaced by npm or node argv impersonation", () => {
  const commands = [["npm", "run", "build"], ["npm", "pack"], ["npm", "install", "artifact.tgz"], ["/bin/node", "-e", consumer]];
  const forged = pipeline(commands);
  for (const event of forged.executions) event.args = event.args.replace(/^"[^"]*"/, '"/bin/echo"');
  assert.notEqual(observePackagePipeline({ trace: forged, retain }).pipeline?.length, 4);
  assert.equal(observePackagePipeline({ trace: forged, retain }).pipelineCandidates.length, 0);
});
test("a replaced npm image cannot borrow its replacement's successful PID exit", () => {
  const observed = pipeline([["npm", "pack"]]);
  observed.executions[0].executionId = "1:1";
  observed.executions[0].outcome = { kind: "replaced", timestamp: 2, replacement: "1:2" };
  assert.deepEqual(observePackagePipeline({ trace: observed, retain }), {});
  delete observed.executions[0].outcome;
  assert.deepEqual(observePackagePipeline({ trace: observed, retain }), {});
});
test("pipeline observations require actual successful execution and terminal records, not command keywords", () => {
  const commands = [["npm", "run", "build"], ["npm", "pack"], ["npm", "install", "--offline", "artifact.tgz"], ["node", "--input-type=module", "-e", consumer]];
  assert.deepEqual(observePackagePipeline({ retain }), {});
  const diagnostic = observePackagePipeline({ trace: pipeline(commands), retain });
  assert.deepEqual(diagnostic.pipelineCandidates.map(value => value.step), ["build", "pack", "install", "consumer"]);
  assert.equal(diagnostic.pipeline, undefined);
  assert.equal(diagnostic.availability, "unavailable");
  assert.deepEqual(observePackagePipeline({ trace: pipeline(commands, null), retain }), {});
  for (const argv of [["node", "consumer.mjs"], ["node", "-e", "console.log('consumer')"]]) assert.deepEqual(observePackagePipeline({ trace: pipeline([argv]), retain }), {});
  const extra = pipeline([["npm", "run", "test"], ["npm", "install", "not-an-archive"], ["git", "status"], ["node", "unknown.mjs"], ...commands]);
  extra.executions.push({ timestamp: -1, result: "-1 ENOENT", args: "not executable" }, { timestamp: -2, result: "0", args: "not decoded" });
  assert.equal(observePackagePipeline({ trace: extra, retain }).pipelineCandidates.length, 4);
  assert.deepEqual(observePackagePipeline({ trace: { ...trace(), executions: [{ result: "0", args: "not decoded" }] }, retain }), {});
});

let sequence = 0;
async function fixtureFor(caseId = "packed-deliverable") {
  const root = workRoot(`source-observation-${++sequence}`);
  const definition = dataset.cases.find(value => value.id === caseId);
  const fixture = await materializeFixture({ manifest, fixtureId: definition.fixture, sourceRoot: dataRoot, roots: Object.fromEntries(["actor", "checker", "canonical"].map(role => [role, path.join(root, role)])), gitIdentity: { authorName: "Fixture", authorEmail: "fixture@example.invalid", committerName: "Fixture", committerEmail: "fixture@example.invalid" } });
  const sourceBefore = listRegularFiles(fixture.actorView.root);
  const args = { fixture, sourceBefore, reviews: [], checkpoints: [], trace: trace(), retain };
  const observe = (mode, extra = {}) => observeSource({ ...args, ...extra, check: { id: mode, expectation: { mode, target: "fixture", checkpoint: "discussion", targetRelativePath: "target.mjs" } } });
  return { root, actor: fixture.actorView.root, args, observe };
}
test("source observations use committed bytes and reject unsupported or mismatched archive provenance", async () => {
  const f = await fixtureFor();
  assert.equal(f.observe("installed_public_matrix").archive, undefined);
  const stage = path.join(f.root, "stage");
  const pkg = path.join(stage, "package");
  fs.mkdirSync(pkg, { recursive: true });
  const source = fs.readFileSync(path.join(f.actor, "src/retry-policy.mjs"));
  const description = fs.readFileSync(path.join(f.actor, "package.json"));
  const entry = JSON.parse(description).exports.slice(2);
  fs.mkdirSync(path.dirname(path.join(pkg, entry)), { recursive: true });
  fs.writeFileSync(path.join(pkg, entry), source);
  fs.writeFileSync(path.join(pkg, "package.json"), description);
  const archive = path.join(f.actor, "result.tgz");
  const pack = () => execFileSync("tar", ["-czf", archive, "-C", stage, "package"], { timeout: 10000 });
  pack();
  assert.equal(f.observe("installed_public_matrix").archive.status, "observed");
  fs.writeFileSync(path.join(f.actor, "unexpected"), "not generated");
  assert.equal(f.observe("installed_public_matrix").commitVerified, false);
  fs.unlinkSync(path.join(f.actor, "unexpected"));
  for (const exports of [{ import: "./dist/index.mjs" }, "node:fs"]) {
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ exports }));
    pack();
    assert.equal(f.observe("installed_public_matrix").archive.status, "invalid");
  }
  fs.writeFileSync(path.join(pkg, "package.json"), description);
  fs.appendFileSync(path.join(pkg, entry), "\n// changed\n");
  pack();
  assert.notEqual(f.observe("installed_public_matrix").archive.entrySha256, f.observe("installed_public_matrix").archive.committedSourceSha256);
  fs.writeFileSync(path.join(pkg, entry), source);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ ...JSON.parse(description), version: "99.0.0" }));
  pack();
  assert.notEqual(f.observe("installed_public_matrix").archive.packageSha256, f.observe("installed_public_matrix").archive.committedPackageSha256);
  fs.copyFileSync(archive, path.join(f.actor, "other.tgz"));
  assert.equal(f.observe("installed_public_matrix").archive, undefined);
});
test("review and canonical facts are extracted from actual retained controller records", async () => {
  const f = await fixtureFor();
  const rawRef = retain("review.json", {});
  const record = (turnIndex, value, resultType = "success") => ({ turnIndex, sessionId: "subject", rawRef, result: { resultType, textResultForLlm: JSON.stringify(value) } });
  f.args.reviews = [
    record(0, { dependencyFailureObserved: true, completion: "not-complete" }, "failure"),
    record(1, { sha: "a".repeat(40), findings: ["finding"], reviewerSessionId: "reviewer" }),
    record(2, { sha: "b".repeat(40), admitted: true, reviewerSessionId: "rereviewer" }),
    { turnIndex: 5, result: { textResultForLlm: "not-json" } },
  ];
  assert.equal(f.observe("expected_dependency_failure").reviewOutcome, "unknown");
  assert.equal(f.observe("independent_review_truth").review, null, "Review prose is not native exact-source readback");
  assert.equal(f.observe("repair_and_rereview").review, null);
  const restart = { task: { track: "track", slug: "task" } };
  assert.equal(f.observe("canonical_identity_truth", { restart, checkpoints: [{ sessionId: "old" }, { sessionId: "new" }] }).freshSessionObserved, true);
  assert.equal(f.observe("canonical_identity_truth", { restart, checkpoints: [{ sessionId: "same" }, { sessionId: "same" }] }).freshSessionObserved, false);
  assert.equal(f.observe("repair_and_rereview", { reviews: [record(2, { admitted: true, reviewerSessionId: "subject" })] }).review, null);
  assert.equal(f.observe("expected_dependency_failure", { reviews: [] }).reviewOutcome, "unknown");
  assert.equal(f.observe("independent_review_truth", { reviews: [] }).review, null);
  assert.equal(f.observe("repair_and_rereview", { reviews: [] }).review, null);
});

test("T14 the blocked dependency phase requires native failure readback rather than a failure-shaped message", async () => {
  const f = await fixtureFor("review-recovery-state");
  const bytes = jsonBytes({ sessionId: "subject", sha: "a".repeat(40), failure: { code: "ENOENT" } });
  const rawRef = { path: "native-blocked.json", sha256: sha256(bytes) };
  const review = { turnIndex: 0, sessionId: "subject", result: { resultType: "failure", textResultForLlm: JSON.stringify({ sha: "a".repeat(40), rawRef, completion: "not-complete" }) } };
  const observed = f.observe("expected_dependency_failure", { reviews: [review], readArtifact: () => bytes });
  assert.equal(observed.reviewOutcome, "unavailable");
  assert.equal(observed.routeBound, true);
  assert.throws(() => f.observe("expected_dependency_failure", { reviews: [review], readArtifact: () => Buffer.from("{}") }), { code: "RAW_REFERENCE_MISMATCH" });
});

test("T14 native review readback binds exact source, output, distinct session, admission and completed capture", async () => {
  const f = await fixtureFor("review-recovery-state");
  const artifacts = new Map();
  const put = (name, value) => { const bytes = jsonBytes(value); artifacts.set(name, bytes); return { path: name, sha256: sha256(bytes) }; };
  const sourceCommit = f.observe("semantic_truth").sourceCommit;
  const bytes = Buffer.from([JSON.stringify({ type: "session.start", data: { sessionId: "reviewer" } }), JSON.stringify({ type: "assistant.message", data: { content: "Source reviewed" } })].join("\n") + "\n");
  const sessionRef = put("native-session.json", { base64: bytes.toString("base64"), sha256: sha256(bytes) });
  const output = Buffer.from("Native review output");
  const native = { sha: sourceCommit, sessionId: "subject", argv: ["review", sourceCommit], outputBase64: output.toString("base64"), drainedFully: true, failure: null, result: { result: { code: 0, signal: null }, survived: [], unverified: [] } };
  const executionRef = put("native-execution.json", native);
  const record = { sha: sourceCommit, reviewerSessionId: "reviewer", rawRef: sessionRef, outputSha256: sha256(output), argv: native.argv };
  const admissionRef = put("native-admission.json", { record, admitted: { admitted: false, findings: ["delivery discounted"] }, rawRef: executionRef });
  const review = { turnIndex: 1, sessionId: "subject", admissionRef, rawRef: retain("review.json", {}), result: { textResultForLlm: JSON.stringify({ sha: sourceCommit, rawRef: executionRef, admitted: true, findings: [] }) } };
  const observe = () => f.observe("independent_review_truth", { reviews: [review], readArtifact: name => artifacts.get(name) }).review;
  assert.deepEqual(observe().findings, ["delivery discounted"], "Parent reads native admission, not candidate-facing success prose");
  assert.equal(observe().sourceCommit, sourceCommit);
  for (const delta of [{ sha: "0".repeat(40) }, { drainedFully: false }, { result: { ...native.result, survived: [42] } }, { outputBase64: Buffer.from("changed").toString("base64") }]) {
    const changedRef = put("changed-execution.json", { ...native, ...delta });
    review.result.textResultForLlm = JSON.stringify({ rawRef: changedRef });
    assert.throws(observe, { code: "REVIEW_READBACK_CHANGED" });
  }
  review.result.textResultForLlm = JSON.stringify({ rawRef: executionRef });
  artifacts.set(executionRef.path, Buffer.from("{}"));
  assert.throws(observe, { code: "RAW_REFERENCE_MISMATCH" }, "A stale reference must not fall back to prose");
});

test("T14 edit-and-revert remains visible in native writer operations when endpoint trees match", async () => {
  const f = await fixtureFor("discussion-then-go");
  const filename = path.join(f.actor, "src/policy.mjs");
  const original = fs.readFileSync(filename);
  fs.appendFileSync(filename, "\n// transient edit\n");
  fs.writeFileSync(filename, original);
  f.args.fixture.writeProbe = { filename: path.join(f.actor, "probe"), rawRef: retain("probe.json", {}) };
  f.args.fixture.writableTargetVerified = true;
  f.args.trace.operations = [{ call: "openat", args: `AT_FDCWD, ${JSON.stringify(filename)}, O_WRONLY|O_TRUNC`, result: `4<${filename}>`, timestamp: 1, pid: 1 }];
  assert.equal(f.observe("preserve_counterexample").sourceChanged, true);
  assert.equal(f.observe("preserve_counterexample", { trace: { ...f.args.trace, traceCoverage: "unavailable" } }).availability, "unavailable");
});

test("T14 target readback distinguishes the exact approved challenge, decoy, missing cwd and transient writes", async () => {
  const f = await fixtureFor("capability-probe-authority");
  const before = listRegularFiles(f.actor);
  assert.equal(readSourceState({ root: f.actor, retain }).status, "");
  assert.deepEqual(listRegularFiles(f.actor), before, "Reading the source/diff must not refresh the stopped Git index");
  for (const relative of ["approved/challenge.mjs", "approved-copy/challenge.mjs"]) {
    const event = { result: "0", args: `${JSON.stringify(process.execPath)}, ${JSON.stringify(["node", path.join(f.actor, relative)])}, 0x0`, outcome: { kind: "exited", exitCode: 0 } };
    const observed = f.observe("target_truth", { trace: { ...trace(), executions: [event] } });
    assert.equal(observed.subjectTarget.relativePath, relative);
    assert.equal(observed.subjectTarget.initialSha256, observed.subjectTarget.sourceSha256);
    const relativeEvent = { ...event, args: `${JSON.stringify(process.execPath)}, ${JSON.stringify(["node", relative])}, 0x0` };
    assert.equal(f.observe("target_truth", { trace: { ...trace(), executions: [relativeEvent] } }).availability, "unavailable");
    assert.equal(f.observe("target_truth", { trace: { ...trace(), executions: [{ ...relativeEvent, cwd: f.actor }] } }).subjectTarget.relativePath, relative);
    assert.equal(f.observe("target_truth", { trace: { ...trace(), executions: [event], operations: [{ call: "openat", args: `AT_FDCWD, ${JSON.stringify(path.join(f.actor, relative))}, O_TRUNC`, result: "4", timestamp: 1, pid: 1 }] } }).availability, "unavailable");
  }
  const unknown = { result: "0", args: `${JSON.stringify(process.execPath)}, ${JSON.stringify(["node", path.join(f.actor, "missing/challenge.mjs")])}, 0x0`, outcome: { kind: "exited", exitCode: 0 } };
  assert.equal(f.observe("target_truth", { trace: { ...trace(), executions: [unknown] } }).availability, "unavailable");
});

test("T14 absent tar tooling is unavailable evidence, not a corrupt delivered product", async () => {
  const f = await fixtureFor();
  const filename = path.join(f.actor, "artifact.tgz");
  fs.writeFileSync(filename, "archive");
  const archive = listRegularFiles(f.actor).find(file => file.path === "artifact.tgz");
  const script = `import {inspectArchive} from ${JSON.stringify(new URL("../source-observations.mjs", import.meta.url).href)};try{inspectArchive({...${JSON.stringify({ root: f.actor, archive, sourceCommit: "a".repeat(40) })},retain:()=>({})});}catch(error){process.stdout.write(error.code);}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PATH: path.join(f.root, "no-tools") }, encoding: "utf8", timeout: 10000, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CHECK_ARTIFACT_UNAVAILABLE");
});

test("T14-fix I3 dependency artifacts distinguish absence from integrity and parse faults", async t => {
  const f = await fixtureFor("review-recovery-state");
  for (const [mode, expected] of [["missing", null], ["io", "EIO"], ["tamper", "RAW_REFERENCE_MISMATCH"], ["parse", "REVIEW_READBACK_INVALID"], ["structure", "JSON_STRUCTURE_LIMIT"], ["bug", "TypeError"]]) await t.test(mode, () => {
    const bytes = mode === "parse" ? Buffer.from("{") : mode === "structure" ? Buffer.from('{"x":'.repeat(70) + "0" + "}".repeat(70)) : jsonBytes({ sessionId: "subject", sha: "a".repeat(40), failure: { code: "ENOENT" } });
    const rawRef = { path: "blocked.json", sha256: sha256(bytes) };
    const review = { turnIndex: 0, sessionId: "subject", result: { textResultForLlm: JSON.stringify({ sha: "a".repeat(40), rawRef, completion: "not-complete" }) } };
    const readArtifact = () => {
      if (mode === "missing") return undefined;
      if (mode === "io") throw Object.assign(new Error("host I/O failure"), { code: "EIO" });
      if (mode === "bug") throw new TypeError("broken reader");
      return mode === "tamper" ? Buffer.from("{}") : bytes;
    };
    const observe = () => f.observe("expected_dependency_failure", { reviews: [review], readArtifact });
    if (expected === null) assert.equal(observe().routeBound, false);
    else assert.throws(observe, expected === "TypeError" ? { name: "TypeError" } : { code: expected });
  });
});

test("T14-fix I3 native reviewer session digest tampering does not become absent evidence", async () => {
  const f = await fixtureFor("review-recovery-state");
  const artifacts = new Map();
  const put = (name, value) => { const bytes = jsonBytes(value); artifacts.set(name, bytes); return { path: name, sha256: sha256(bytes) }; };
  const sessionRef = put("session.json", { base64: Buffer.from("{}\n").toString("base64"), sha256: "0".repeat(64) });
  const native = { sha: "a".repeat(40), sessionId: "subject", argv: ["review"], outputBase64: "", drainedFully: true, failure: null, result: { result: { code: 0, signal: null }, survived: [], unverified: [] } };
  const executionRef = put("execution.json", native);
  const admissionRef = put("admission.json", { record: { sha: native.sha, reviewerSessionId: "reviewer", rawRef: sessionRef, outputSha256: sha256(""), argv: native.argv }, admitted: { admitted: true, findings: [] }, rawRef: executionRef });
  const review = { turnIndex: 1, sessionId: "subject", admissionRef, result: { textResultForLlm: JSON.stringify({ rawRef: executionRef }) } };
  assert.throws(() => f.observe("independent_review_truth", { reviews: [review], readArtifact: name => artifacts.get(name) }), { code: "REVIEW_READBACK_CHANGED" });
});

test("T14-fix I3 complete native identities distinguish missing completion from malformed history", async t => {
  const f = await fixtureFor("review-recovery-state");
  for (const [mode, code] of [["missing-session", null], ["not-drained", null], ["exit-failure", null], ["empty-session", null], ["no-output", null], ["malformed-history", "REVIEW_READBACK_INVALID"], ["wrong-session", "REVIEW_READBACK_CHANGED"], ["malformed-completion", "REVIEW_READBACK_INVALID"], ["malformed-execution", "REVIEW_READBACK_INVALID"]]) await t.test(mode, () => {
    const artifacts = new Map();
    const put = (name, value) => { const bytes = jsonBytes(value); artifacts.set(name, bytes); return { path: name, sha256: sha256(bytes) }; };
    const events = [{ type: "session.start", data: { sessionId: mode === "wrong-session" ? "other" : "reviewer" } }, { type: "assistant.message", data: { content: "reviewed" } }];
    const bytes = mode === "empty-session" ? Buffer.alloc(0) : mode === "malformed-history" ? Buffer.from("{") : Buffer.from((mode === "no-output" ? events.slice(0, 1) : events).map(event => JSON.stringify(event)).join("\n") + "\n");
    const sessionRef = put("session.json", { base64: bytes.toString("base64"), sha256: sha256(bytes) });
    const native = { sha: "a".repeat(40), sessionId: "subject", argv: ["review"], outputBase64: "", drainedFully: mode === "malformed-execution" ? "yes" : mode !== "not-drained", failure: null, result: { result: mode === "malformed-completion" ? null : { code: mode === "exit-failure" ? 1 : 0, signal: null }, survived: [], unverified: [] } };
    const executionRef = put("execution.json", native);
    const admissionRef = put("admission.json", { record: { sha: native.sha, reviewerSessionId: "reviewer", rawRef: sessionRef, outputSha256: sha256(""), argv: native.argv }, admitted: { admitted: true, findings: [] }, rawRef: executionRef });
    const review = { turnIndex: 1, sessionId: "subject", admissionRef, result: { textResultForLlm: JSON.stringify({ rawRef: executionRef }) } };
    if (mode === "missing-session") artifacts.delete(sessionRef.path);
    const observe = () => f.observe("independent_review_truth", { reviews: [review], readArtifact: name => artifacts.get(name) }).review;
    if (code === null) assert.equal(observe(), null);
    else assert.throws(observe, { code });
  });
});

test("T14-fix I4 a bounded-size archive with many small members cannot buy unbounded tar processes", async () => {
  const f = await fixtureFor();
  const stage = path.join(f.root, "large-stage");
  fs.mkdirSync(path.join(stage, "package"), { recursive: true });
  fs.writeFileSync(path.join(stage, "package/large"), Buffer.alloc(1048576, "x"));
  for (let index = 0; index < 70; index++) fs.writeFileSync(path.join(stage, `package/small-${index}`), "x");
  const filename = path.join(f.actor, "many-members.tgz");
  execFileSync("tar", ["-czf", filename, "-C", stage, "package"]);
  const archive = listRegularFiles(f.actor).find(file => file.path === "many-members.tgz");
  const evidence = [];
  assert.throws(() => inspectArchive({ root: f.actor, archive, sourceCommit: "a".repeat(40), retain: (name, value) => { evidence.push(value); return retain(name, value); } }), error => error.code === "CHECK_ARTIFACT_UNAVAILABLE" && error.cause?.code === "ARCHIVE_INSPECTION_LIMIT");
  assert.equal(evidence.at(-1).inspection.processes, 2, "Reject the declared work before starting the per-member loop");
});

test("T14-fix I4 each archive command shares one aggregate deadline", async t => {
  const f = await fixtureFor();
  const filename = path.join(f.actor, "deadline.tgz");
  execFileSync("tar", ["-czf", filename, "-C", f.actor, "package.json"]);
  const archive = listRegularFiles(f.actor).find(file => file.path === "deadline.tgz");
  let ticks = 0;
  const start = performance.now();
  t.mock.method(performance, "now", () => start + (++ticks < 3 ? 0 : 10001));
  const evidence = [];
  assert.throws(() => inspectArchive({ root: f.actor, archive, sourceCommit: "a".repeat(40), retain: (name, value) => { evidence.push(value); return retain(name, value); } }), error => error.code === "CHECK_ARTIFACT_UNAVAILABLE" && error.cause?.code === "ARCHIVE_INSPECTION_LIMIT");
  assert.equal(evidence.at(-1).inspection.processes, 1, "The second command cannot reset the first command's deadline");
});

test("T14-fix I4 an actual decoded-output overflow remains unavailable evidence", async () => {
  const f = await fixtureFor();
  const stage = path.join(f.root, "overflow-stage");
  fs.mkdirSync(path.join(stage, "package"), { recursive: true });
  fs.writeFileSync(path.join(stage, "package/oversized"), Buffer.alloc(17 * 1024 * 1024, "x"));
  const filename = path.join(f.actor, "overflow.tgz");
  execFileSync("tar", ["-czf", filename, "-C", stage, "package"]);
  const archive = listRegularFiles(f.actor).find(file => file.path === "overflow.tgz");
  assert.throws(() => inspectArchive({ root: f.actor, archive, sourceCommit: "a".repeat(40), retain }), error => error.code === "CHECK_ARTIFACT_UNAVAILABLE" && error.cause?.code === "ENOBUFS");
});

test("T14-fix I1 the source observer retains structural failure without converting host faults", async () => {
  const f = await fixtureFor("discussion-then-go");
  fs.rmSync(path.join(f.actor, ".git"), { recursive: true });
  const observed = f.observe("repair_and_commit");
  assert.equal(observed.sourceFailure.code, "CHECK_SOURCE_IDENTITY_UNAVAILABLE");
  assert.match(observed.sourceFailure.rawRef.sha256, /^[a-f0-9]{64}$/);
  const valid = await fixtureFor("discussion-then-go");
  assert.throws(() => valid.observe("repair_and_commit", { retain: () => { throw Object.assign(new Error("retention I/O failure"), { code: "EIO" }); } }), { code: "EIO" });
});

test("T14-fix I1 nonzero Git host diagnostics and spawn failures remain infrastructure faults", async () => {
  const f = await fixtureFor("discussion-then-go");
  const tools = path.join(f.root, "host-tools");
  fs.mkdirSync(tools);
  const program = `import {readSourceState} from ${JSON.stringify(new URL("../source-observations.mjs", import.meta.url).href)};try{readSourceState({root:${JSON.stringify(f.actor)},retain:()=>({})});}catch(error){process.stdout.write(JSON.stringify({code:error.code??null,status:error.status??null}));}`;
  for (const diagnostic of [
    `fatal: unable to read ${"a".repeat(40)}\nerror: Input/output error`,
    "fatal: bad object HEAD\nerror: Permission denied",
    "fatal: out of memory",
    "fatal: unknown internal failure",
  ]) {
    fs.writeFileSync(path.join(tools, "git"), `#!/bin/sh\nprintf '%s\\n' '${diagnostic}' >&2\nexit 128\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, PATH: tools }, encoding: "utf8", timeout: 10000, maxBuffer: 8192 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { code: null, status: 128 });
  }
  fs.unlinkSync(path.join(tools, "git"));
  const missing = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, PATH: tools }, encoding: "utf8", timeout: 10000, maxBuffer: 8192 });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).code, "ENOENT");
});

test("T14 source readback must not execute candidate Git clean filters in the parent", async () => {
  const f = await fixtureFor("discussion-then-go");
  const marker = path.join(f.root, "parent-filter-ran");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout)`;
  execFileSync("git", ["-C", f.actor, "config", "filter.candidate.clean", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`]);
  fs.writeFileSync(path.join(f.actor, ".gitattributes"), "*.mjs filter=candidate\n");
  fs.appendFileSync(path.join(f.actor, "src/policy.mjs"), "\n// changed\n");
  const observed = f.observe("semantic_truth");
  assert.equal(fs.existsSync(marker), false, "A source reader must not run candidate-supplied Git conversion commands");
  assert.equal(observed.commitVerified, false);
  assert.equal(observed.sourceChanged, true);
});

test("T14 raw Git readback retains deleted, executable-mode and staged-only changes without refreshing the index", async () => {
  const f = await fixtureFor("discussion-then-go");
  fs.unlinkSync(path.join(f.actor, "src/policy.mjs"));
  fs.chmodSync(path.join(f.actor, "baseline.test.mjs"), 0o700);
  const filename = 'added\n"name.mjs';
  fs.writeFileSync(path.join(f.actor, filename), "export const added=1;\n");
  execFileSync("git", ["-C", f.actor, "add", "--", filename, "src/policy.mjs"]);
  const before = listRegularFiles(f.actor);
  const state = readSourceState({ root: f.actor, retain });
  assert.equal(state.changes.find(row => row.path === "src/policy.mjs").observedSha256, null);
  assert.ok(state.changes.some(row => row.path === "baseline.test.mjs"));
  const indexSha256 = sha256("export const added=1;\n");
  assert.equal(state.changes.filter(row => row.path === filename).length, 1);
  assert.deepEqual(state.changes.find(row => row.path === filename), { path: filename, committedSha256: null, indexSha256, observedSha256: indexSha256 });
  assert.deepEqual(listRegularFiles(f.actor), before);
  fs.appendFileSync(path.join(f.actor, filename), "// unstaged change\n");
  const modified = readSourceState({ root: f.actor, retain });
  assert.ok(modified.status.includes(`AM ${JSON.stringify(filename)}`));
  assert.notEqual(modified.changes.find(row => row.path === filename).observedSha256, indexSha256);
  fs.unlinkSync(path.join(f.actor, filename));
  assert.deepEqual(readSourceState({ root: f.actor, retain }).changes.find(row => row.path === filename), { path: filename, committedSha256: null, indexSha256, observedSha256: null }, "A staged addition cannot be hidden by deleting its working file");
});

test("T14 raw readback distinguishes staged-only and unstaged changes to committed source", async t => {
  const f = await fixtureFor("discussion-then-go");
  const filename = path.join(f.actor, "src/policy.mjs");
  fs.appendFileSync(filename, "\n// staged change\n");
  execFileSync("git", ["-C", f.actor, "add", "--", "src/policy.mjs"]);
  await t.test("staged-only", () => assert.ok(readSourceState({ root: f.actor, retain }).status.includes("M  src/policy.mjs")));
  fs.appendFileSync(filename, "// unstaged change\n");
  await t.test("staged and unstaged", () => assert.ok(readSourceState({ root: f.actor, retain }).status.includes("MM src/policy.mjs")));
  fs.unlinkSync(filename);
  await t.test("unstaged deletion", () => assert.ok(readSourceState({ root: f.actor, retain }).status.includes("MD src/policy.mjs")));
  execFileSync("git", ["-C", f.actor, "add", "-u"]);
  await t.test("staged deletion", () => assert.ok(readSourceState({ root: f.actor, retain }).status.includes("D  src/policy.mjs")));
  fs.writeFileSync(filename, "untracked after staged deletion\n");
  const restored = readSourceState({ root: f.actor, retain });
  assert.ok(restored.status.includes("D  src/policy.mjs"));
  assert.ok(restored.status.includes("?? src/policy.mjs"));
});

test("T14 source inspection refuses redirected Git metadata before reading another store", async () => {
  for (const redirect of ["commondir", "objects/info/alternates", "info/grafts", "gitfile"]) {
    const f = await fixtureFor("discussion-then-go");
    if (redirect === "gitfile") {
      fs.renameSync(path.join(f.actor, ".git"), path.join(f.actor, ".saved-git"));
      fs.writeFileSync(path.join(f.actor, ".git"), "gitdir: /not-the-subject\n");
    } else {
      const filename = path.join(f.actor, ".git", redirect);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "/not-the-subject\n");
    }
    assert.throws(() => readSourceState({ root: f.actor, retain }), { code: "CHECK_SOURCE_IDENTITY_UNAVAILABLE" });
  }
});
test("source challenges and preservation keep observed writes and authority attempts separate from final bytes", async () => {
  const f = await fixtureFor();
  f.args.fixture.writeProbe = { filename: path.join(f.actor, "probe"), rawRef: retain("probe.json", {}) };
  f.args.fixture.writableTargetVerified = true;
  assert.throws(() => f.observe("preserve_counterexample", { trace: null }), { code: "TRACE_UNAVAILABLE" });
  assert.throws(() => f.observe("target_truth", { trace: null }), { code: "TRACE_UNAVAILABLE" });
  f.args.trace.operations = f.args.trace.mutations;
  for (const args of ['"/other"', `"${f.actor}/.git/index"`, `"${f.actor}/probe"`]) f.args.trace.mutations.push({ call: "unlink", args, result: "0", succeeded: true });
  f.args.trace.mutations.push({ call: "unlink", args: `"${f.actor}/source"`, result: "-1 EACCES", succeeded: false });
  assert.equal(f.observe("preserve_counterexample").sourceChanged, true);
  assert.equal(f.observe("preserve_counterexample").availability, "unavailable", "A probe pathname alone does not authorize arbitrary future operations on it");
  f.args.trace.mutations.push({ call: "unlink", args: `"${f.actor}/source"`, result: "0", succeeded: true }, { call: "unlink", args: `"${f.actor}/.git/config"`, result: "0", succeeded: true });
  f.args.trace.executions.push({ args: '"git", ["git", "push"], 0x0', result: "-1 EPERM" });
  assert.equal(f.observe("preserve_counterexample").sourceChanged, true);
  assert.equal(f.observe("preserve_counterexample").remoteOrDefaultMutation, true);
  assert.equal(f.observe("target_truth").challengeCandidate, false);
  f.args.trace.executions.push({ args: '"node", ["node", "target.mjs"], 0x0', result: "0" });
  assert.equal(f.observe("target_truth").challengeCandidate, true);
  assert.equal(f.observe("target_truth").challengeExecuted, undefined);
  assert.equal(f.observe("target_truth").availability, "unavailable");
  assert.equal(f.observe("semantic_truth").sourceChanged, false);
});
test("FD writes use actual opens, duplication and process lineage; uncertain authority never becomes a clean negative", () => {
  const root = "/fixture";
  const run = operations => observeAuthority({ trace: { operations: operations.map(([call, args, result, pid = 1], timestamp) => ({ call, args, result, pid, timestamp })) }, root, probe: "/fixture/probe" });
  assert.throws(() => observeAuthority({ trace: {}, root }), { code: "TRACE_AUTHORITY_UNAVAILABLE" });
  assert.deepEqual(run([["write", "0x1, 0xab, 0x2", "0x2"]]), { sourceWrite: false, authorityWrite: false, unresolved: false });
  assert.deepEqual(run([["openat", 'AT_FDCWD, "source", O_WRONLY', "4</fixture/source>"]]), { sourceWrite: true, authorityWrite: false, unresolved: false });
  assert.equal(run([["openat", 'AT_FDCWD, "source", O_WRONLY', "4</fixture/source>"], ["write", "0x4, 0xab, 0x2", "0x2"]]).sourceWrite, true);
  assert.equal(run([["openat", 'AT_FDCWD, "source", O_WRONLY', "4</fixture/source>"], ["write", "0x4, 0xab, 0x2", "0"]]).sourceWrite, true);
  assert.equal(run([["write", "0x9, 0xab, 0x2", "0x2"]]).unresolved, true);
  assert.equal(run([["unlink", '"relative"', "0"]]).unresolved, true);
  assert.equal(run([["unlink", "0x123", "0"]]).unresolved, true);
  assert.equal(run([["openat", '0, "file", O_TRUNC', "4"]]).unresolved, true);
  assert.equal(run([["creat", '"/fixture/source", 0600', "4</fixture/source>"]]).sourceWrite, true);
  assert.equal(run([["openat", '0, "file", O_TRUNC', "4</fixture/source>"]]).sourceWrite, true);
  const opened = ["openat", '0, "file", O_RDONLY', "4</fixture/source>"];
  for (const call of ["dup", "dup2", "dup3", "fcntl"]) {
    assert.equal(run([opened, [call, "4, F_DUPFD, 8", "8"], ["ftruncate", "8, 0", "0"]]).sourceWrite, true);
  }
  for (const flags of ["SIGCHLD", "CLONE_FILES"]) assert.equal(run([opened, ["clone", `flags=${flags}`, "2"], ["ftruncate", "4, 0", "0", 2]]).sourceWrite, true);
  for (const close of [["close", "4", "0"], ["close_range", "3, 99, 0", "0"], ["execve", '"/bin/node", ["node"], 0x0', "0"]]) assert.equal(run([opened, close, ["ftruncate", "4, 0", "0"]]).unresolved, true);
  for (const call of ["socket", "accept", "accept4"]) assert.equal(run([[call, "0, 0, 0", "4"], ["write", "4, 0xab, 1", "1"]]).unresolved, true);
  for (const call of ["pipe", "pipe2", "socketpair"]) assert.equal(run([[call, "[4, 5], 0", "0"], ["write", "5, 0xab, 1", "1"]]).unresolved, false);
  assert.throws(() => run([["pipe", "0x123", "0"]]), { code: "TRACE_AUTHORITY_UNAVAILABLE" });
  assert.equal(run([["connect", "4, 0x123, 10", "0"]]).unresolved, true);
  assert.equal(run([["sendto", "0x4, 0x123, 0xa, 0, 0x456, 0x10", "0xa"]]).unresolved, true);
  assert.equal(run([["connect", "4, 0x123, 10", "-1 EPERM"]]).unresolved, true);
});

test("authority tracks denied operations without changing descriptor ownership and never exempts arbitrary canonical paths", () => {
  const run = operations => observeAuthority({ root: "/fixture", probe: "/fixture/probe", trace: { operations: operations.map(([call, args, result], timestamp) => ({ call, args, result, timestamp, pid: 1 })) } });
  const opened = ["open", '"/other-repo/source", O_RDONLY', "4</other-repo/source>"];
  for (const operation of [
    ["close", "4", "-1 EINTR"], ["close_range", "4, 9", "-1 EPERM"], ["dup2", "1, 4", "-1 EPERM"], ["execve", '"/bin/tool", [], 0x0', "-1 ENOENT"],
  ]) assert.equal(run([opened, operation, ["write", "4, 0, 1", "-1 EACCES"]]).authorityWrite, true);
  for (const filename of ["/fixture", "/fixture/.git", "/fixture/.git/index", "/fixture/../other-repo/source", "/canonical/task.md"]) {
    const result = run([["unlink", JSON.stringify(filename), "-1 EACCES"]]);
    assert.ok(result.sourceWrite || result.authorityWrite);
  }
  assert.equal(run([["openat", 'AT_FDCWD, "/fixture/source", O_TRUNC', "-1 EACCES"]]).sourceWrite, true);
  assert.equal(run([["openat", 'AT_FDCWD, "unresolved", O_TRUNC', "-1 EACCES"]]).unresolved, true);
  assert.equal(run([["openat", "AT_FDCWD, 0x123, O_TRUNC", "-1 EFAULT"]]).unresolved, true);
  assert.equal(run([["openat", 'AT_FDCWD, "/fixture/probe", O_WRONLY', "4</fixture/probe>"]]).unresolved, true);
  assert.equal(run([["new_unknown_mutation", "0, 0", "-1 EPERM"]]).unresolved, true);
  assert.equal(run([["stat", '"/fixture/source"', "0"]]).unresolved, false);
  for (const call of ["clone", "socket", "pipe"]) assert.equal(run([[call, "0, 0", "-1 EPERM"]]).unresolved, false);
  assert.equal(run([["fcntl", "4, F_SETFD, FD_CLOEXEC", "0"]]).unresolved, true);
});

test("even recognized actual executable paths lack trusted exec-byte, cwd and artifact route bindings", () => {
  const programs = [
    [process.execPath, ["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "pack"]],
    ["/usr/local/bin/npm", ["npm", "pack"]],
    ["/usr/bin/node", ["node", "-e", consumer]],
    ["/bin/node", ["node", "-e", consumer]],
  ];
  for (const [executable, argv] of programs) {
    const trace_ = pipeline([argv]);
    trace_.executions[0].args = `${JSON.stringify(executable)}, ${JSON.stringify(argv)}, 0x0`;
    const observed = observePackagePipeline({ trace: trace_, retain });
    assert.equal(observed.pipelineCandidates.length, 1);
    assert.equal(observed.pipeline, undefined);
    assert.equal(observed.availability, "unavailable");
  }
  for (const args of ['"/bin/node", {}, 0x0', '"/bin/node", [7], 0x0', '"relative/node", ["node"], 0x0']) {
    assert.deepEqual(observePackagePipeline({ trace: { ...trace(), executions: [{ args, result: "0" }] }, retain }), {});
  }
});
