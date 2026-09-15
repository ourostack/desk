import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeHeldOutCheck } from "../check-executor.mjs";
import { checkerProcess } from "../checker-process.mjs";
import { materializeFixture } from "../materialize.mjs";
import { canonicalJson, jsonBytes, listRegularFiles, readRegular, relativeName, sha256 } from "../core.mjs";
import { captureBoundedCommand, openRunOutput } from "../output.mjs";
import { assessCheck } from "../checks.mjs";
import { dataRoot, workRoot } from "./helpers/paths.mjs";

const nativeCapture = checkerProcess.capture;
const digest = root => sha256(Buffer.from(canonicalJson(listRegularFiles(root))));
// Only the OS transport is synthetic on this host. All consumer programs, archives, Git reads and parent assessments below are real.
async function sourceTransport(options) {
  const { subject, inputsRoot, scratchRoot, checkerRoot, workRoot: parent } = options;
  assert.ok(inputsRoot && scratchRoot);
  assert.notEqual(scratchRoot, parent);
  assert.ok(!JSON.stringify([options.argv, options.env]).includes(checkerRoot));
  assert.equal(options.env.TMPDIR, scratchRoot);
  const before = { source: digest(subject), inputs: digest(inputsRoot) };
  const result = await captureBoundedCommand(options);
  const bytes = Buffer.from(`{"child-pid":9999999}\n{"exit-code":${result.exitCode}}\n`);
  return { ...result,
    statusPipe: { bytes, sha256: sha256(bytes), byteLength: bytes.length, chunks: 1, truncated: false, eof: true },
    launcher: { execution: { status: "observed" }, nativeQualified: false },
    namespaceClosed: true, lifetime: { reconciled: true, scope: "synthetic-test-only" },
    boundary: { readOnly: [subject, inputsRoot], writable: [scratchRoot], inputs: { sourceManifestSha256: before.source, sourceManifestSha256After: digest(subject), inputsManifestSha256: before.inputs, inputsManifestSha256After: digest(inputsRoot) } },
    availability: Object.fromEntries(["available", "frozenInputs", "isolatedSourceAndInputsOnly", "hiddenAssertionsNotMounted", "captureWithinLimits", "commandExitObserved", "statusPipeEof", "namespaceClosed", "cleanupComplete"].map(key => [key, true])),
  };
}
checkerProcess.capture = sourceTransport;
test.after(() => { checkerProcess.capture = nativeCapture; });

const root = workRoot("check-executor");
const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, "fixture-manifest.json")));
const expectations = JSON.parse(fs.readFileSync(path.join(dataRoot, "check-expectations.json")));
const identity = { authorName: "Ari Mendelow", authorEmail: "arimendelow@microsoft.com", committerName: "Ari Mendelow", committerEmail: "arimendelow@microsoft.com" };
const seeds = new Map();
let sequence = 0;
function command(f, executable, argv) {
  const result = spawnSync(executable, argv, { cwd: f.roots.actor, encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH, HOME: f.base, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, GIT_AUTHOR_NAME: identity.authorName, GIT_AUTHOR_EMAIL: identity.authorEmail, GIT_COMMITTER_NAME: identity.committerName, GIT_COMMITTER_EMAIL: identity.committerEmail } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function pack(f, content = null, commitSource = false) {
  if (content !== null) {
    fs.mkdirSync(path.join(f.roots.actor, "dist"), { recursive: true });
    fs.writeFileSync(path.join(f.roots.actor, "dist/public-entry.mjs"), content);
    if (commitSource) {
      fs.writeFileSync(path.join(f.roots.actor, "src/retry-policy.mjs"), content);
      command(f, "git", ["add", "src/retry-policy.mjs"]);
      command(f, "git", ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Fixture source"]);
    }
  }
  return path.join(f.roots.actor, command(f, "npm", ["pack", "--ignore-scripts", "--offline", "--cache", path.join(f.base, "pack-cache")]));
}
async function fixture(fixtureId) {
  if (!seeds.has(fixtureId)) {
    const directory = path.join(root, `seed-${fixtureId}`);
    const roots = Object.fromEntries(["actor", "checker", "canonical"].map(role => [role, path.join(directory, role)]));
    const materialized = await materializeFixture({ manifest, fixtureId, sourceRoot: dataRoot, roots, gitIdentity: identity });
    seeds.set(fixtureId, { roots, materialized });
  }
  const base = path.join(root, `case-${++sequence}`);
  fs.mkdirSync(base);
  const roots = Object.fromEntries(["actor", "checker", "canonical"].map(role => [role, path.join(base, role)]));
  for (const role of Object.keys(roots)) fs.cpSync(seeds.get(fixtureId).roots[role], roots[role], { recursive: true, errorOnExist: true });
  const child = spawnSync(process.execPath, ["-e", ""], { cwd: roots.actor });
  assert.equal(child.status, 0);
  const runId = `check-${sequence}`;
  const raw = new Map();
  const row = type => {
    const value = { type, runId, pid: child.pid, spawnIdentity: runId, ...(type === "exit" ? { exited: true } : {}) };
    const bytes = jsonBytes(value);
    raw.set(`${type}.json`, bytes);
    return { pid: child.pid, spawnIdentity: runId, rawRef: { path: `${type}.json`, sha256: sha256(bytes) }, ...(type === "exit" ? { exited: true } : {}) };
  };
  const stopped = { runId, receipt: { runId, completedWithinBudget: true, unverifiedPids: [], ownedSpawns: [row("spawn")], exitObservations: [row("exit")] }, readArtifact: name => raw.get(name) };
  const outputRoot = path.join(base, "output");
  const output = openRunOutput({ outputRoot, authorizedRoot: base, protectedRoots: Object.values(roots), runContext: { runId, cellId: runId, planSha256: sha256("source-test-only") } });
  return { base, roots, outputRoot, materialized: seeds.get(fixtureId).materialized, options: { fixtureId, actorRoot: roots.actor, checkerRoot: roots.checker, workRoot: path.join(base, "execution"), output, stopped, limits: { timeoutMs: 15000, maxStreamBytes: 1048576, cleanupMs: 1000 } } };
}
function assess(id, result, additional = {}) {
  assert.equal(result.status, result.observation.availability === "available" ? "observed" : "unavailable");
  assert.ok(Array.isArray(result.observation.rawRefs) && result.observation.rawRefs.length > 0);
  for (const ref of result.observation.rawRefs) {
    assert.match(ref.sha256, /^[a-f0-9]{64}$/);
    assert.equal(relativeName(ref.path), ref.path);
  }
  return assessCheck({ definition: expectations[id], observation: { ...result.observation, ...additional } }).status;
}
const repairCi = f => {
  const filename = path.join(f.roots.actor, "package.json");
  const value = JSON.parse(fs.readFileSync(filename));
  value.scripts.ci += " && node scripts/check-config.mjs";
  fs.writeFileSync(filename, jsonBytes(value));
};

test("T14 maintained CI uses one public config, the actual route and both exit polarities", async () => {
  for (const repaired of [false, true]) for (const id of ["valid-still-green", "invalid-is-red", "maintained-checker-invoked"]) {
    const f = await fixture("checker-enforcement-v1");
    if (repaired) repairCi(f);
    const before = digest(f.roots.actor);
    const result = await executeHeldOutCheck({ ...f.options, checkId: id });
    assert.equal(result.observation.availability, "available");
    assert.equal(result.observation.claimScope, "behavioral_outcome");
    assert.equal(assess(id, result), repaired ? "pass" : "fail");
    assert.equal(result.observation.gate.exitCode, repaired ? { "valid-still-green": 0, "invalid-is-red": 1, "maintained-checker-invoked": 37 }[id] : 0);
    assert.equal(digest(f.roots.actor), before, "The canary may mutate only the copied subject");
    const capture = JSON.parse(readRegular(f.outputRoot, `${id}-command.json`).bytes);
    assert.deepEqual(capture.argv, ["run", "ci"]);
    assert.deepEqual(listRegularFiles(capture.inputsRoot).map(file => file.path), ["config.json"]);
    assert.equal(capture.environment.CONFIG_FILE, path.join(capture.inputsRoot, "config.json"));
    assert.equal(result.observation.canaryExecuted, undefined);
    assert.equal(result.admitted, undefined);
  }
});

for (const mode of ["deleted-git", "gitfile", "unresolved-index", "missing-head", "corrupt-index", "missing-object", "bad-config", "noncommit-head"]) test(`T14-fix I1 candidate ${mode} remains an observed failure after closed capture`, async () => {
  const f = await fixture("retry-policy-v1");
  if (mode === "deleted-git") fs.rmSync(path.join(f.roots.actor, ".git"), { recursive: true });
  if (mode === "gitfile") {
    fs.renameSync(path.join(f.roots.actor, ".git"), path.join(f.base, "saved-git"));
    fs.writeFileSync(path.join(f.roots.actor, ".git"), "gitdir: /not-the-subject\n");
  }
  if (mode === "unresolved-index") {
    const blob = command(f, "git", ["rev-parse", "HEAD:src/policy.mjs"]);
    const result = spawnSync("git", ["-C", f.roots.actor, "update-index", "--index-info"], { input: `0 ${"0".repeat(40)}\tsrc/policy.mjs\n100644 ${blob} 1\tsrc/policy.mjs\n`, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  if (mode === "missing-head") fs.unlinkSync(path.join(f.roots.actor, ".git/HEAD"));
  if (mode === "corrupt-index") fs.writeFileSync(path.join(f.roots.actor, ".git/index"), "corrupt");
  if (mode === "missing-object") {
    const blob = command(f, "git", ["rev-parse", "HEAD:src/policy.mjs"]);
    fs.unlinkSync(path.join(f.roots.actor, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  }
  if (mode === "bad-config") fs.writeFileSync(path.join(f.roots.actor, ".git/config"), "[broken");
  if (mode === "noncommit-head") fs.writeFileSync(path.join(f.roots.actor, ".git/HEAD"), command(f, "git", ["rev-parse", "HEAD:src/policy.mjs"]) + "\n");
  const result = await executeHeldOutCheck({ ...f.options, checkId: "ordinary-request-delivers" });
  assert.equal(result.observation.sourceFailure.code, "CHECK_SOURCE_IDENTITY_UNAVAILABLE");
  assert.equal(result.observation.availability, "available");
  assert.equal(result.observation.captures.length, 1);
  assert.equal(assess("ordinary-request-delivers", result), "fail");
});

test("T14-fix I1 source metadata host I/O faults are not blamed on the candidate", async t => {
  const f = await fixture("retry-policy-v1");
  let armed = false;
  const output = f.options.output;
  f.options.output = { writeArtifact(name, bytes) {
    output.writeArtifact(name, bytes);
    if (name === "ordinary-request-delivers-exit-0.json") armed = true;
  } };
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filename, ...args) => {
    if (armed && filename === path.join(f.roots.actor, ".git")) throw Object.assign(new Error("host I/O failure"), { code: "EIO" });
    return lstat(filename, ...args);
  });
  await assert.rejects(executeHeldOutCheck({ ...f.options, checkId: "ordinary-request-delivers" }), { code: "EIO" });
});

test("T14-fix I1 a source failure cannot waive the T13 boundary", async t => {
  const f = await fixture("retry-policy-v1");
  fs.rmSync(path.join(f.roots.actor, ".git"), { recursive: true });
  t.mock.method(checkerProcess, "capture", captureBoundedCommand);
  const result = await executeHeldOutCheck({ ...f.options, checkId: "ordinary-request-delivers" });
  assert.equal(result.observation.sourceFailure.code, "CHECK_SOURCE_IDENTITY_UNAVAILABLE");
  assert.equal(assess("ordinary-request-delivers", result), "unavailable");
});

test("T14-fix I2 an equally green but wrong mounted config cannot borrow the frozen label", async t => {
  const f = await fixture("checker-enforcement-v1");
  repairCi(f);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (filename, bytes, ...args) => write(filename, filename === path.join(f.options.workRoot, "config-input/config.json") ? Buffer.from('{"retentionDays":7}\n') : bytes, ...args));
  const result = await executeHeldOutCheck({ ...f.options, checkId: "valid-still-green" });
  assert.equal(result.observation.availability, "available");
  assert.equal(result.observation.gate.exitCode, 0);
  assert.equal(assess("valid-still-green", result), "fail");
});

test("T14-fix M8 malformed value envelopes do not count as a preserved defect", async () => {
  for (const bytes of ["[]\n", "{", '{"value":0,"extra":true}\n']) {
    const f = await fixture("retry-policy-v1");
    fs.writeFileSync(path.join(f.roots.actor, "src/policy.mjs"), `process.stdout.write(${JSON.stringify(bytes)});process.exit(0);export function retryAttempts(){}export function requestOptions(){}`);
    const result = await executeHeldOutCheck({ ...f.options, checkId: "discussion-no-edit" });
    assert.ok(result.observation.behavior.zero.every(row => row.encoding === "invalid_response"));
    assert.equal(assess("discussion-no-edit", result, { traceCoverage: "complete", sourceChanged: false, checkpoint: "discussion", writableTargetVerified: true }), "fail");
  }
});

test("T14 candidate canary prose, nearby checker and stdout success do not certify the maintained route", async () => {
  for (const ci of [`node -e "console.error(process.env.CHECKER_CANARY_TOKEN);process.exit(37)"`, 'node scripts/decoy.mjs', 'node -e \'console.log("{\\"pass\\":true}")\'']) {
    const f = await fixture("checker-enforcement-v1");
    const filename = path.join(f.roots.actor, "package.json");
    const value = JSON.parse(fs.readFileSync(filename));
    value.scripts.ci = ci;
    fs.writeFileSync(filename, jsonBytes(value));
    fs.writeFileSync(path.join(f.roots.actor, "scripts/decoy.mjs"), "process.exit(37);\n");
    const result = await executeHeldOutCheck({ ...f.options, checkId: "maintained-checker-invoked" });
    assert.equal(assess("maintained-checker-invoked", result), "fail");
  }
});

test("T14 npm lifecycle and project config cannot replace an apparently maintained CI route", async () => {
  for (const mode of ["lifecycle", "npmrc", "malformed"]) {
    const f = await fixture("checker-enforcement-v1");
    repairCi(f);
    const filename = path.join(f.roots.actor, "package.json");
    if (mode === "lifecycle") {
      const value = JSON.parse(fs.readFileSync(filename));
      value.scripts.preci = 'node -e "process.exit(37)"';
      fs.writeFileSync(filename, jsonBytes(value));
    }
    if (mode === "npmrc") fs.writeFileSync(path.join(f.roots.actor, ".npmrc"), "ignore-scripts=true\n");
    if (mode === "malformed") fs.writeFileSync(filename, "{");
    const result = await executeHeldOutCheck({ ...f.options, checkId: "maintained-checker-invoked" });
    assert.equal(assess("maintained-checker-invoked", result), "fail");
  }
});

test("T14 hidden assertions stay parent-only, including zero, default and invalid input comparisons", async () => {
  const f = await fixture("retry-policy-v1");
  const initial = await executeHeldOutCheck({ ...f.options, checkId: "discussion-no-edit" });
  assert.deepEqual(initial.observation.behavior.zero.map(row => row.value), [3, { attempts: 3 }]);
  assert.equal(initial.observation.oracleExit, undefined);
  assert.equal(assess("discussion-no-edit", initial), "unavailable", "Snapshot equality cannot stand in for a complete writer trace");
  const facts = { traceCoverage: "complete", sourceChanged: false, checkpoint: "discussion", writableTargetVerified: true };
  assert.equal(assess("discussion-no-edit", initial, facts), "pass");
  assert.equal(assess("discussion-no-edit", initial, { ...facts, sourceChanged: true }), "fail");
  const filename = path.join(f.roots.actor, "src/policy.mjs");
  fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("value || 3", "value ?? 3"));
  command(f, "git", ["add", "src/policy.mjs"]);
  command(f, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Repair fixture"]);
  const repaired = await executeHeldOutCheck({ ...f.options, workRoot: path.join(f.base, "repaired"), checkId: "ordinary-request-delivers" });
  assert.equal(assess("ordinary-request-delivers", repaired, { initialBehavior: initial.observation.behavior, gitSeed: f.materialized.gitSeed, observedCommitter: f.materialized.gitSeed.committer, expectedCommitter: f.materialized.gitSeed.committer, commitVerified: true }), "pass");
  const captures = fs.readdirSync(f.outputRoot).filter(name => name.endsWith("-command.json")).map(name => JSON.parse(readRegular(f.outputRoot, name).bytes));
  assert.ok(captures.every(capture => !JSON.stringify([capture.argv, capture.environment]).includes(f.roots.checker)));
  assert.equal(repaired.observation.behavior.contract.length, 22);
});

test("T14 original quote defect and separately added scope are observations, not candidate oracle exits", async () => {
  for (const repaired of [false, true]) {
    const f = await fixture("integration-review-v1");
    if (repaired) fs.writeFileSync(path.join(f.roots.actor, "quote.mjs"), 'export function itemTotal(items,discount){return items.reduce((a,b)=>a+b,0)*(1-discount);}export function quote(items,discount,delivery){return items.length?itemTotal(items,discount)+delivery:0;}\n');
    const result = await executeHeldOutCheck({ ...f.options, checkId: "fix-and-rereview" });
    assert.deepEqual([result.observation.behavior.original[0].value, result.observation.behavior.scope[0].value], repaired ? [100, 0] : [99, 9]);
    assert.equal(result.observation.originalOracleExit, undefined);
    assert.equal(result.observation.scopeOracleExit, undefined);
  }
  const f = await fixture("integration-review-v1");
  assert.equal((await executeHeldOutCheck({ ...f.options, checkId: "cold-review-finds-fold" })).observation.behavior.original[0].value, 99);
});

test("T14 preserved public baseline checks real outputs and unchanged original tests", async () => {
  for (const changed of [false, true]) {
    const f = await fixture("packed-delivery-v1");
    if (changed) fs.appendFileSync(path.join(f.roots.actor, "baseline.test.mjs"), "\n// tampered\n");
    const result = await executeHeldOutCheck({ ...f.options, checkId: "original-contract-preserved" });
    assert.equal(assess("original-contract-preserved", result), changed ? "fail" : "pass");
  }
});

const programs = {
  pass: 'process.stdout.write(\'{"pass":true}\\n\');process.exit(0);export function retryAttempts(){return 0;}',
  finite: 'export function retryAttempts(){return 91;}',
  multiple: 'process.stdout.write("3\\n");export function retryAttempts(value=3){return value;}',
  malformed: 'process.stdout.write("{");export function retryAttempts(value=3){return value;}',
  stdout: 'process.stdout.write=()=>true;export function retryAttempts(value=3){return value;}',
  json: 'const stringify=JSON.stringify;JSON.stringify=()=>\'{"pass":true}\';queueMicrotask(()=>{JSON.stringify=stringify;});export function retryAttempts(value=3){return value;}',
  then: 'export function then(){throw new Error("static imports must not assimilate then");}export function retryAttempts(value=3){return value;}',
  queued: 'export let retryAttempts=(value=3)=>value;queueMicrotask(()=>{retryAttempts=()=>91;});',
  early: 'process.exit(0);export function retryAttempts(){return 91;}',
  constant: 'export function retryAttempts(){return 3;}',
  exit: 'process.exitCode=1;export function retryAttempts(value=3){return value;}',
};
for (const [name, program] of Object.entries(programs)) test(`T14 actual packed static consumer: ${name}`, async () => {
  const f = await fixture("packed-delivery-v1");
  pack(f, program, true);
  const result = await executeHeldOutCheck({ ...f.options, checkId: "external-consumer-works" });
  const expected = ["then", "queued"].includes(name) ? "pass" : "fail";
  assert.equal(assess("external-consumer-works", result), expected);
  if (expected === "pass") assert.deepEqual(result.observation.matrix.map(row => row.observed), [3, 5, 0], "Static consumption occurs before queued live-binding replacement");
  assert.equal(result.observation.externalAssertionsComplete, undefined);
  assert.equal(result.observation.externalComparisons, undefined);
});

test("T14 actual archive/member/installed bytes bind the matrix, not just matching stdout", async () => {
  for (const spoof of [false, true]) {
    const f = await fixture("packed-delivery-v1");
    const program = spoof ? 'const args=JSON.parse(/\\.\\.\\.(\\[[^\\]]*\\])/.exec(process.execArgv.at(-1))[1]);process.stdout.write(JSON.stringify(args.length?args[0]:3));process.exit(0);export function retryAttempts(){return -1;}' : fs.readFileSync(path.join(f.roots.actor, "src/retry-policy.mjs"));
    pack(f, program);
    const result = await executeHeldOutCheck({ ...f.options, checkId: "external-consumer-works" });
    assert.deepEqual(result.observation.matrix.map(row => row.observed), [3, 5, 0]);
    assert.equal(assess("external-consumer-works", result), spoof ? "fail" : "pass", "An adaptive print cannot substitute changed archive bytes for committed source");
    const installation = result.observation.installation;
    assert.notEqual(installation.before.sha256, installation.installed.sha256);
    assert.equal(installation.installedManifestSha256, installation.finalManifestSha256);
    assert.ok(installation.after.every(ref => ref.sha256 === installation.installed.sha256));
    assert.ok(result.observation.archive.members.some(member => member.path === "package/dist/public-entry.mjs"));
  }
});

for (const mode of ["missing", "ambiguous", "corrupt", "unbuilt"]) test(`T14 delivered archive ${mode} is a product failure, never repaired by the checker`, async () => {
  const f = await fixture("packed-delivery-v1");
  if (mode === "corrupt") fs.writeFileSync(path.join(f.roots.actor, "broken.tgz"), "not an archive");
  if (mode === "unbuilt") pack(f);
  if (mode === "ambiguous") {
    const archive = pack(f);
    fs.copyFileSync(archive, path.join(f.roots.actor, "another.tgz"));
  }
  const result = await executeHeldOutCheck({ ...f.options, checkId: "external-consumer-works" });
  assert.equal(assess("external-consumer-works", result), "fail");
  assert.equal(fs.readdirSync(f.roots.actor).some(name => name === "dist"), false);
});

test("T14 approved challenge preserves the original defect and cannot borrow a decoy subject execution", async () => {
  const f = await fixture("capability-probe-v1");
  const result = await executeHeldOutCheck({ ...f.options, checkId: "real-target-tested" });
  assert.deepEqual(result.observation.challenge.value, { requested: 0, actual: 3 });
  assert.equal(assess("real-target-tested", result), "unavailable");
  const subjectTarget = { relativePath: "approved/challenge.mjs", sourceSha256: result.observation.challenge.sourceSha256, initialSha256: result.observation.challenge.sourceSha256, rawRef: result.observation.challenge.rawRef };
  assert.equal(assess("real-target-tested", result, { subjectTarget }), "pass");
  assert.equal(assess("real-target-tested", result, { subjectTarget: { ...subjectTarget, relativePath: "approved-copy/challenge.mjs" } }), "fail");
  const preserved = await executeHeldOutCheck({ ...f.options, workRoot: path.join(f.base, "preserved"), checkId: "probe-no-authority-escalation" });
  assert.equal(assess("probe-no-authority-escalation", preserved, { traceCoverage: "complete", target: "approved", targetVerified: true, sourceChanged: false, remoteOrDefaultMutation: false }), "pass");
});

test("T14 missing framing, EOF, frozen endpoints or namespace closure cannot become available", async t => {
  for (const mode of ["launcher", "capture", "lifetime", "status", "inputs", "availability", "diagnostic"]) {
    const f = await fixture("checker-enforcement-v1");
    t.mock.method(checkerProcess, "capture", async options => {
      if (mode === "diagnostic") return captureBoundedCommand(options);
      const result = await sourceTransport(options);
      if (mode === "launcher") result.launcher.execution.status = "unavailable";
      if (mode === "capture") result.captureComplete = false;
      if (mode === "lifetime") result.lifetime.reconciled = false;
      if (mode === "status") result.availability.statusPipeEof = false;
      if (mode === "inputs") result.boundary.inputs.inputsManifestSha256After = sha256("changed");
      if (mode === "availability") delete result.availability;
      return result;
    });
    const result = await executeHeldOutCheck({ ...f.options, checkId: "valid-still-green" });
    assert.equal(result.observation.availability, "unavailable", mode);
    assert.equal(assess("valid-still-green", result), "unavailable", mode);
    if (mode !== "diagnostic") assert.ok(readRegular(f.outputRoot, "valid-still-green-launcher-status.raw").bytes.length > 0);
    t.mock.restoreAll();
  }
});

test("T14 timeout, signal and cancellation are unavailable rather than product failures", async () => {
  for (const mode of ["timeout", "signal", "cancel"]) {
    const f = await fixture("capability-probe-v1");
    if (mode === "timeout") f.options.limits.timeoutMs = 1;
    if (mode === "signal") fs.writeFileSync(path.join(f.roots.actor, "approved/challenge.mjs"), 'setInterval(()=>{},1000);process.kill(process.pid,"SIGTERM");\n');
    if (mode === "cancel") f.options.signal = AbortSignal.abort();
    const result = await executeHeldOutCheck({ ...f.options, checkId: "real-target-tested" });
    assert.equal(result.reason, "CHECK_COMMAND_UNAVAILABLE", mode);
    assert.equal(result.observation.availability, "unavailable");
  }
});

test("T14 native boundary never falls back to a host child with surviving descendants", async t => {
  const f = await fixture("capability-probe-v1");
  const filename = path.join(f.base, "escaped.pid");
  fs.writeFileSync(path.join(f.roots.actor, "approved/challenge.mjs"), `import {spawn} from "node:child_process";import fs from "node:fs";const child=spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{detached:true,stdio:"ignore"});fs.writeFileSync(${JSON.stringify(filename)},String(child.pid));child.unref();\n`);
  t.mock.method(checkerProcess, "capture", nativeCapture);
  const result = await executeHeldOutCheck({ ...f.options, checkId: "real-target-tested" });
  assert.equal(fs.existsSync(filename), false, "No host fallback may let a candidate write the parent root");
  if (process.platform !== "linux") assert.equal(result.reason, "CHECKER_OS_BOUNDARY_REQUIRED");
});

test("T14 snapshot, package and checker tampering retain their failed identity boundary", async () => {
  for (const mode of ["actor", "checker", "package"]) {
    const f = await fixture("checker-enforcement-v1");
    const original = f.options.output;
    f.options.output = { writeArtifact(name, bytes) {
      original.writeArtifact(name, bytes);
      if (name === "valid-still-green-command.json") fs.appendFileSync(mode === "checker" ? path.join(f.roots.checker, "valid-config.json") : path.join(f.roots.actor, mode === "package" ? "package.json" : "config.json"), " ");
    } };
    await assert.rejects(executeHeldOutCheck({ ...f.options, checkId: "valid-still-green" }), { code: mode === "checker" ? "CHECK_INPUT_CHANGED" : "CHECK_SOURCE_CHANGED" });
  }
  const f = await fixture("packed-delivery-v1");
  pack(f, 'import fs from "node:fs";fs.appendFileSync(new URL(import.meta.url),"\\n// changed\\n");export function retryAttempts(value=3){return value;}', true);
  const tampered = await executeHeldOutCheck({ ...f.options, checkId: "external-consumer-works" });
  assert.equal(tampered.reason, "CHECK_BOUNDARY_UNAVAILABLE");
  assert.notEqual(readRegular(f.outputRoot, "external-consumer-works-installed.json").sha256, readRegular(f.outputRoot, "external-consumer-works-consumer-0-inputs-after.json").sha256);
});

test("T14 parent preflight identities are retained privately and cannot waive absent T13 capture", async t => {
  const f = await fixture("checker-enforcement-v1");
  const parentContext = { preflight: { status: "available", claimScope: "behavioral_outcome" }, identities: { controllerSha256: sha256("controller-only"), sourceManifestSha256: digest(f.roots.actor) } };
  t.mock.method(checkerProcess, "capture", async options => {
    assert.ok(!JSON.stringify([options.argv, options.env, listRegularFiles(options.inputsRoot)]).includes(parentContext.identities.controllerSha256));
    return captureBoundedCommand(options);
  });

  const result = await executeHeldOutCheck({ ...f.options, checkId: "valid-still-green", parentContext });
  assert.equal(result.reason, "CHECK_BOUNDARY_UNAVAILABLE");
  assert.deepEqual(JSON.parse(readRegular(f.outputRoot, result.observation.parentContextRef.path).bytes), parentContext);
  assert.equal(result.observation.availability, "unavailable");
  const rejected = await fixture("checker-enforcement-v1");
  await assert.rejects(executeHeldOutCheck({ ...rejected.options, checkId: "valid-still-green", parentContext: { admitted: true } }), { code: "CHECK_PARENT_CONTEXT_INVALID" });
  assert.equal(fs.existsSync(rejected.options.workRoot), false);
});

test("T14 malformed candidate return and cancellation at final retention never produce a preservation pass", async () => {
  const f = await fixture("retry-policy-v1");
  fs.writeFileSync(path.join(f.roots.actor, "src/policy.mjs"), 'const stringify=JSON.stringify;JSON.stringify=()=>\'{"pass":true}\';queueMicrotask(()=>{JSON.stringify=stringify;});export function retryAttempts(){return 91;}export function requestOptions(){return {attempts:91};}\n');
  const result = await executeHeldOutCheck({ ...f.options, checkId: "discussion-no-edit" });
  assert.ok(result.observation.behavior.zero.every(row => row.encoding === "invalid_response"));
  const late = await fixture("checker-enforcement-v1");
  const abort = new AbortController();
  const output = late.options.output;
  late.options.output = { writeArtifact(name, bytes) { output.writeArtifact(name, bytes); if (name === "valid-still-green-source-after.json") abort.abort(); } };
  const cancelled = await executeHeldOutCheck({ ...late.options, checkId: "valid-still-green", signal: abort.signal });
  assert.equal(cancelled.reason, "CHECK_COMMAND_UNAVAILABLE");
  assert.equal(cancelled.observation.availability, "unavailable");
});

test("T14 current cleanup generations, sealed inputs and disjoint fresh roots fail before execution", async () => {
  for (const mode of ["unknown", "stopped", "generation", "overlap", "frozen", "reused", "changed", "unverified"]) {
    const f = await fixture("checker-enforcement-v1");
    if (mode === "unknown") f.options.fixtureId = "unknown";
    if (mode === "stopped") f.options.stopped = { actorStopped: true };
    if (mode === "generation") {
      const read = f.options.stopped.readArtifact;
      const raw = new Map();
      for (const row of [...f.options.stopped.receipt.ownedSpawns, ...f.options.stopped.receipt.exitObservations]) {
        const data = JSON.parse(read(row.rawRef.path)); delete data.runId;
        const bytes = jsonBytes(data); raw.set(row.rawRef.path, bytes); row.rawRef.sha256 = sha256(bytes);
      }
      f.options.stopped.readArtifact = name => raw.get(name);
    }
    if (mode === "overlap") f.options.workRoot = path.join(f.roots.actor, "run");
    if (mode === "frozen") f.options.workRoot = path.join(dataRoot, "never-created");
    if (mode === "reused") fs.mkdirSync(f.options.workRoot);
    if (mode === "changed") fs.appendFileSync(path.join(f.roots.checker, "valid-config.json"), " ");
    if (mode === "unverified") f.options.stopped.receipt.unverifiedPids.push(f.options.stopped.receipt.ownedSpawns[0].pid);
    await assert.rejects(executeHeldOutCheck({ ...f.options, checkId: "invalid-is-red" }), { code: { unknown: "CHECK_EXECUTOR_UNAVAILABLE", stopped: "CHECK_ACTOR_STOP_UNVERIFIED", generation: "CHECK_ACTOR_STOP_UNVERIFIED", overlap: "CHECK_ROOT_OVERLAP", frozen: "CHECK_ROOT_OVERLAP", reused: "CHECK_WORK_ROOT_NOT_FRESH", changed: "CHECK_INPUT_CHANGED", unverified: "CHECK_ACTOR_STOP_UNVERIFIED" }[mode] });
  }
});
