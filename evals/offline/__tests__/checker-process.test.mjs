import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { captureConfinedChecker, qualifyCheckerBoundary } from "../checker-process.mjs";
import { sha256 } from "../core.mjs";
import { workRoot } from "./helpers/paths.mjs";

// The parent owns every root here. Only `subject`, `inputs` and `scratch` may ever reach the candidate.
function roots(name) {
  const root = workRoot(name);
  const value = { root, subject: path.join(root, "subject"), inputs: path.join(root, "inputs"), scratch: path.join(root, "scratch"), checker: path.join(root, "checker") };
  for (const key of ["subject", "inputs", "scratch", "checker"]) fs.mkdirSync(value[key], { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(value.subject, "delivered.mjs"), "export const delivered = 1;\n", { mode: 0o600 });
  fs.writeFileSync(path.join(value.inputs, "public-input.json"), '{"arguments":[1]}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(value.checker, "oracle.test.mjs"), "// held-out assertions\n", { mode: 0o600 });
  fs.writeFileSync(path.join(value.checker, "expected-matrix.json"), '{"expected":42}\n', { mode: 0o600 });
  return value;
}

test("checker namespace construction is fail-closed and never treats launcher output as native qualification", async t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const tree = roots("checker-process");
  const root = tree.root;
  const options = { executable: "/opt/node/bin/node", argv: ["-e", "candidate"], cwd: tree.subject, workRoot: root, subject: tree.subject, checkerRoot: tree.checker, env: { HOME: tree.scratch, PATH: "/opt/node/bin:/usr/bin:/bin" }, limits: { timeoutMs: 1000, maxStreamBytes: 1024, cleanupMs: 100 } };
  Object.defineProperty(process, "platform", { value: "darwin" });
  await assert.rejects(captureConfinedChecker(options), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  Object.defineProperty(process, "platform", { value: "linux" });
  const lstat = fs.lstatSync;
  let mode = "missing";
  t.mock.method(fs, "lstatSync", (filename, ...args) => {
    if (filename !== "/usr/bin/bwrap") return lstat(filename, ...args);
    if (mode === "missing" || mode === "denied") throw Object.assign(new Error("Test launcher fault"), { code: mode === "missing" ? "ENOENT" : "EACCES" });
    return { uid: mode === "owner" ? 99 : 0, mode: mode === "writable" ? 0o100777 : 0o100755, isFile: () => mode !== "link" };
  });
  await assert.rejects(captureConfinedChecker(options), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  mode = "denied";
  await assert.rejects(captureConfinedChecker(options), { code: "EACCES" });
  for (mode of ["owner", "writable", "link"]) await assert.rejects(captureConfinedChecker(options), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  mode = "valid";
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (filename, ...args) => filename === "/usr/bin/bwrap" ? Buffer.from("Synthetic binary identity, not native proof") : read(filename, ...args));
  const realpath = fs.realpathSync;
  let runtime = "/opt/node/bin/node";
  t.mock.method(fs, "realpathSync", (filename, ...args) => filename === process.execPath ? runtime : realpath(filename, ...args));
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", filename => ["/opt/node", "/usr", "/bin", "/lib"].includes(filename) || exists(filename));
  runtime = "/bin/node";
  await assert.rejects(captureConfinedChecker(options), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  runtime = "/opt/node/bin/node";
  await assert.rejects(captureConfinedChecker({ ...options, subject: "/usr/candidate" }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  let invocation;
  let statusBytes = "";
  let exitSignal = null;
  t.mock.method(childProcess, "spawn", (executable, argv, settings) => {
    invocation = { executable, argv, settings };
    const child = Object.assign(new EventEmitter(), { pid: 999999, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()] });
    queueMicrotask(() => {
      child.stdout.end("untrusted namespace-looking output");
      child.stdio[3].end(statusBytes);
      child.emit("close", 1, exitSignal);
    });
    return child;
  });
  syncBuiltinESMExports();
  const result = await captureConfinedChecker(options);
  assert.equal(result.exitCode, 1, "A possible setup failure is retained, not called a product failure");
  assert.equal(result.launcher.nativeQualified, false);
  assert.equal(invocation.executable, "/usr/bin/bwrap");
  assert.deepEqual(invocation.settings.env, { PATH: "/usr/bin:/bin" });
  assert.deepEqual(invocation.argv.slice(0, 13), ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--uid", "65534", "--gid", "65534", "--clearenv", "--json-status-fd", "3", "--ro-bind"]);
  assert.ok(invocation.argv.includes("--proc"));
  assert.ok(invocation.argv.includes("--ro-bind"));
  assert.deepEqual(invocation.argv.slice(-4), ["--", options.executable, "-e", "candidate"]);
  assert.ok(invocation.argv.includes("--json-status-fd"));
  assert.equal(invocation.settings.stdio[3], "pipe");
  assert.equal(result.launcher.execution.status, "unavailable", "stdout and wrapper exit cannot replace the private status pipe");
  statusBytes = '{"child-pid":123,"user-namespace":42}\n{"exit-code":1}\n';
  const observed = await captureConfinedChecker(options);
  assert.deepEqual(observed.launcher.execution, { status: "observed", childPid: 123, shellExitCode: 1, scope: "launcher-reported-initial-child-exit-only" });
  assert.equal(observed.statusPipe.bytes.toString(), statusBytes);
  assert.equal(observed.launcher.nativeQualified, false);
  for (statusBytes of [
    "not json\n",
    '{"exit-code":1}\n',
    '{"child-pid":123}\n',
    '{"child-pid":123}\n{"exit-code":0}\n',
    '{"child-pid":123}\n{"exit-code":1}',
    '{"child-pid":123}\n{"exit-code":1}\n{"exit-code":1}\n',
    '{"child-pid":999999}\n{"exit-code":1}\n',
    '{"child-pid":-1}\n{"exit-code":1}\n',
    'null\n{"exit-code":1}\n',
    '{"child-pid":123}\nnull\n',
    '{"child-pid":123}\n{"exit-code":-1}\n',
    '{"child-pid":123}\n{"exit-code":256}\n',
    '{"child-pid":123}\n{"exit-code":"1"}\n',
  ]) assert.equal((await captureConfinedChecker(options)).launcher.execution.status, "unavailable");
  exitSignal = "SIGKILL";
  assert.equal((await captureConfinedChecker(options)).launcher.execution.status, "unavailable");
  assert.equal((await captureConfinedChecker({ ...options, signal: AbortSignal.abort() })).launcher.execution.status, "unavailable");
});

// Runnable child programs, frozen here so the candidate's exact attempt is visible in the test source.
export const probePrograms = {
  // The child is given the actual parent-only path as an adversarial probe, never its contents.
  "hidden-read": `import fs from "node:fs";
process.stdout.write(JSON.stringify({
  hiddenReadable: fs.existsSync(process.argv[2]),
  hasNodeOptions: Object.hasOwn(process.env, "NODE_OPTIONS"),
  hasNodePath: Object.hasOwn(process.env, "NODE_PATH"),
  hasCoverage: Object.hasOwn(process.env, "NODE_V8_COVERAGE"),
  environment: Object.keys(process.env).sort(),
}) + "\\n");`,
  "write-denied": `import fs from "node:fs";
const attempt = target => { try { fs.writeFileSync(target, "candidate"); return "written"; } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({ source: attempt(process.argv[3]), inputs: attempt(process.argv[4]), scratch: attempt(process.argv[5]) }) + "\\n");`,
  "network-denied": `import net from "node:net";
const done = network => { process.stdout.write(JSON.stringify({ network }) + "\\n"); process.exit(0); };
const socket = net.connect(443, "93.184.216.34");
socket.setTimeout(2000, () => done("timeout"));
socket.on("error", error => done(error.code));
socket.on("connect", () => done("connected"));`,
  "fork-setsid": `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
child.unref();
process.stdout.write(JSON.stringify({ escapedPid: child.pid }) + "\\n");`,
  "capture-bound": `process.stdout.write("x".repeat(1024 * 1024));`,
  cancellation: `setInterval(() => {}, 1000);`,
};

function linuxLauncher(t, tree) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  Object.defineProperty(process, "platform", { value: "linux" });
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filename, ...args) => filename === "/usr/bin/bwrap" ? { uid: 0, mode: 0o100755, isFile: () => true } : lstat(filename, ...args));
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (filename, ...args) => filename === "/usr/bin/bwrap" ? Buffer.from("Synthetic launcher identity, not native proof") : read(filename, ...args));
  const realpath = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (filename, ...args) => filename === process.execPath ? "/opt/node/bin/node" : realpath(filename, ...args));
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", filename => ["/opt/node", "/usr", "/bin", "/lib"].includes(filename) || exists(filename));
  const transport = { invocation: null, stdout: "", statusBytes: "", statusEof: true, exitCode: 0, exitSignal: null, onSpawn: null };
  t.mock.method(childProcess, "spawn", (executable, argv, settings) => {
    transport.invocation = { executable, argv, settings };
    const child = Object.assign(new EventEmitter(), { pid: 777001, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()], kill: () => true });
    // Mirrors the real transport: the child's close follows its stdio EOF, never precedes it.
    let pending = transport.statusEof ? 3 : 2;
    const settle = () => {
      if ((pending -= 1) > 0) return;
      setImmediate(() => {
        if (transport.onSpawn) transport.onSpawn(child);
        else child.emit("close", transport.exitCode, transport.exitSignal);
      });
    };
    child.stdout.once("end", settle);
    child.stderr.once("end", settle);
    if (transport.statusEof) child.stdio[3].once("end", settle);
    queueMicrotask(() => {
      child.stdout.end(transport.stdout);
      child.stderr.end("");
      if (transport.statusEof) child.stdio[3].end(transport.statusBytes);
      else child.stdio[3].write(transport.statusBytes);
    });
    return child;
  });
  syncBuiltinESMExports();
  const options = {
    executable: "/opt/node/bin/node", argv: ["-e", "candidate", tree.checker], cwd: tree.subject,
    workRoot: tree.root, subject: tree.subject, checkerRoot: tree.checker, inputsRoot: tree.inputs, scratchRoot: tree.scratch,
    env: { HOME: tree.scratch, PATH: "/opt/node/bin:/usr/bin:/bin" }, limits: { timeoutMs: 1000, maxStreamBytes: 1024, cleanupMs: 50 },
  };
  transport.statusBytes = `{"child-pid":4242,"exit-code":0}\n`;
  return { transport, options };
}

const complete = status => `{"child-pid":4242}\n{"exit-code":${status}}\n`;

test("the parent-only checker root is never mounted and the candidate receives only source, inputs and its own scratch", async t => {
  const tree = roots("checker-mounts");
  const { transport, options } = linuxLauncher(t, tree);
  transport.statusBytes = complete(0);
  const result = await captureConfinedChecker(options);
  const argv = transport.invocation.argv;
  const mountArgs = argv.slice(0, argv.indexOf("--"));
  assert.ok(argv.includes(tree.checker), "The adversarial probe argument still names the hidden path");
  assert.equal(mountArgs.includes(tree.checker), false, "No mount may expose the held-out checker root");
  assert.equal(mountArgs.includes(tree.root), false, "The parent work root is never bound wholesale");
  assert.equal(mountArgs.some(value => value.startsWith(`${tree.checker}/`)), false);
  const roBinds = mountArgs.flatMap((value, index) => value === "--ro-bind" ? [mountArgs[index + 1]] : []);
  const binds = mountArgs.flatMap((value, index) => value === "--bind" ? [mountArgs[index + 1]] : []);
  assert.ok(roBinds.includes(tree.subject) && roBinds.includes(tree.inputs));
  assert.deepEqual(binds, [tree.scratch], "Only the child-owned scratch root is writable");
  assert.equal(result.boundary.hiddenRoots.includes(tree.checker), true);
  assert.equal(result.availability.hiddenAssertionsNotMounted, true);
  assert.equal(result.availability.isolatedSourceAndInputsOnly, true);
  assert.equal(result.availability.available, true);
});

test("credential, loader and coverage environment cannot cross into candidate execution", async t => {
  const tree = roots("checker-env");
  const { options } = linuxLauncher(t, tree);
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "LD_PRELOAD", "GITHUB_TOKEN", "EVAL_API_KEY", "STORE_PASSWORD", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AZURE_STORAGE_CONNECTION_STRING", "CI_JOB_TOKEN", "UNDECLARED_VARIABLE", "npm_config_//registry.npmjs.org/:_authToken", "npm_config_registry"]) {
    await assert.rejects(captureConfinedChecker({ ...options, env: { ...options.env, [name]: "injected" } }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" }, name);
  }
  const declared = await captureConfinedChecker({ ...options, env: { ...options.env, TMPDIR: tree.scratch, npm_config_audit: "false", EVAL_SUBJECT_SNAPSHOT: tree.subject } });
  assert.equal(declared.exitCode, 0, "The declared allowlist still admits the checker's own execution environment");
  await assert.rejects(captureConfinedChecker({ ...options, env: { ...options.env, CONFIG_FILE: path.join(tree.checker, "valid-config.json") } }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, cwd: tree.root }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, cwd: tree.checker }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, scratchRoot: tree.subject }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, scratchRoot: path.join(tree.checker, "scratch") }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, scratchRoot: tree.root }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
  await assert.rejects(captureConfinedChecker({ ...options, inputsRoot: path.join(tree.subject, "inputs") }), { code: "CHECKER_OS_BOUNDARY_REQUIRED" });
});

test("candidate stdout cannot supply namespace, EOF or cleanup facts", async t => {
  const tree = roots("checker-forged-facts");
  const { transport, options } = linuxLauncher(t, tree);
  transport.stdout = JSON.stringify({ captureComplete: true, statusPipeEof: true, namespaceClosed: true, availability: { available: true } });
  transport.statusEof = false;
  transport.statusBytes = complete(0);
  const result = await captureConfinedChecker(options);
  assert.equal(result.stdout.bytes.toString(), transport.stdout, "The raw candidate bytes are still retained");
  assert.equal(result.statusPipeEof, false);
  assert.equal(result.namespaceClosed, false);
  assert.equal(result.captureComplete, false);
  assert.equal(result.availability.available, false);
  assert.equal(result.availability.rawRefs.stdout.sha256, sha256(result.stdout.bytes));
});

test("a nonzero candidate exit is retained and remains available evidence", async t => {
  const tree = roots("checker-nonzero");
  const { transport, options } = linuxLauncher(t, tree);
  transport.exitCode = 3;
  transport.statusBytes = complete(3);
  const result = await captureConfinedChecker(options);
  assert.equal(result.exitCode, 3);
  assert.equal(result.availability.commandExitObserved, true);
  assert.equal(result.availability.available, true);
  assert.equal(result.launcher.nativeQualified, false);
});

test("a killed launcher, a missing exit line and a malformed status all refuse namespace closure", async t => {
  const tree = roots("checker-launcher-faults");
  const { transport, options } = linuxLauncher(t, tree);
  transport.exitSignal = "SIGKILL";
  transport.statusBytes = complete(0);
  assert.equal((await captureConfinedChecker(options)).namespaceClosed, false);
  transport.exitSignal = null;
  transport.statusBytes = `{"child-pid":4242}\n`;
  assert.equal((await captureConfinedChecker(options)).namespaceClosed, false);
  transport.statusBytes = "not json\n";
  const malformed = await captureConfinedChecker(options);
  assert.equal(malformed.namespaceClosed, false);
  assert.equal(malformed.availability.available, false);
  assert.equal(malformed.statusPipe.bytes.toString(), "not json\n", "Malformed launcher bytes are retained, not discarded");
});

test("source changed between capture points is not a frozen-input observation", async t => {
  const tree = roots("checker-changed-source");
  const { transport, options } = linuxLauncher(t, tree);
  transport.statusBytes = complete(0);
  transport.onSpawn = child => {
    fs.writeFileSync(path.join(tree.subject, "delivered.mjs"), "export const delivered = 2;\n", { mode: 0o600 });
    child.emit("close", 0, null);
  };
  const result = await captureConfinedChecker(options);
  assert.equal(result.availability.frozenInputs, false);
  assert.equal(result.availability.frozenInputsScope, "endpoint-manifest-equality", "The fact names what it observed, not continuous immutability");
  assert.equal(result.availability.available, false);
  assert.notEqual(result.boundary.inputs.sourceManifestSha256, result.boundary.inputs.sourceManifestSha256After);
});

test("cancellation before and after spawn stays cancellation and never reports a closed namespace", async t => {
  const tree = roots("checker-cancelled");
  const { transport, options } = linuxLauncher(t, tree);
  transport.statusBytes = complete(0);
  const before = await captureConfinedChecker({ ...options, signal: AbortSignal.abort() });
  assert.equal(before.status, "cancelled");
  assert.equal(before.namespaceClosed, false);
  assert.equal(before.availability.available, false);
  const during = new AbortController();
  transport.onSpawn = child => { during.abort(); queueMicrotask(() => child.emit("close", 0, null)); };
  const late = await captureConfinedChecker({ ...options, signal: during.signal });
  assert.equal(late.status, "cancelled", "A late zero exit does not convert cancellation into completion");
  assert.equal(late.availability.commandExitObserved, false);
  assert.equal(late.availability.available, false);
});

test("the zero-model preflight returns a typed receipt and refuses to claim more than it observed", async t => {
  const tree = roots("checker-preflight");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => Object.defineProperty(process, "platform", platform));
  Object.defineProperty(process, "platform", { value: "darwin" });
  const receipt = await qualifyCheckerBoundary({ workRoot: path.join(tree.root, "preflight"), sourceRoot: tree.subject, controllerRoot: tree.checker, limits: { timeoutMs: 1000, maxStreamBytes: 4096, cleanupMs: 50 } });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.claimScope, "behavioral_outcome");
  assert.equal(receipt.status, "unavailable", "A host without the namespace launcher cannot be qualified");
  assert.deepEqual(Object.keys(receipt.checks).sort(), ["boundedCapture", "frozenIdentities", "hiddenAssertionsSeparated", "isolation", "namespaceCleanup"]);
  assert.equal(Object.values(receipt.checks).every(value => value === false), true);
  assert.match(receipt.identities.sourceManifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.identities.controllerSha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.identities.runtimeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.identities.launcherSha256, null);
  assert.ok(receipt.evidenceRefs.length > 0);
  for (const ref of receipt.evidenceRefs) {
    assert.match(ref.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(sha256(fs.readFileSync(path.join(tree.root, "preflight", ref.path))), ref.sha256);
  }
});

test("an unreadable input root is an unfrozen observation, not an assumed-stable one", async t => {
  const tree = roots("checker-unreadable-inputs");
  const { transport, options } = linuxLauncher(t, tree);
  transport.statusBytes = complete(0);
  const result = await captureConfinedChecker({ ...options, inputsRoot: path.join(tree.root, "absent-inputs") });
  assert.equal(result.boundary.inputs.inputsManifestSha256, null);
  assert.equal(result.availability.frozenInputs, false);
  assert.equal(result.availability.available, false);
});

// Each probe's parent-side observation, keyed by the frozen program the preflight materializes.
const probeResponses = {
  "hidden-read": '{"hiddenReadable":false,"hasNodeOptions":false,"hasNodePath":false,"hasCoverage":false,"environment":["HOME","PATH"]}\n',
  "write-denied": '{"source":"EROFS","inputs":"EROFS","scratch":"written"}\n',
  "network-denied": '{"network":"ENETUNREACH"}\n',
  "fork-setsid": '{"escapedPid":31337}\n',
};

function preflightTransport(t, { hiddenReadable = false, scratchWritable = true, network = "ENETUNREACH", boundedCapture = true } = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  Object.defineProperty(process, "platform", { value: "linux" });
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filename, ...args) => filename === "/usr/bin/bwrap" ? { uid: 0, mode: 0o100755, isFile: () => true } : lstat(filename, ...args));
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (filename, ...args) => filename === "/usr/bin/bwrap" ? Buffer.from("Synthetic launcher identity, not native proof") : read(filename, ...args));
  const realpath = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (filename, ...args) => filename === process.execPath ? "/opt/node/bin/node" : realpath(filename, ...args));
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", filename => ["/opt/node", "/usr", "/bin", "/lib"].includes(filename) || exists(filename));
  const descriptor = 90210;
  let remaining = 0;
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (filename, ...args) => {
    if (filename !== "/usr/bin/bwrap") return open(filename, ...args);
    remaining = 1;
    return descriptor;
  });
  const readSync = fs.readSync;
  t.mock.method(fs, "readSync", (handle, buffer, offset, length, position) => {
    if (handle !== descriptor) return readSync(handle, buffer, offset, length, position);
    if (remaining-- <= 0) return 0;
    return Buffer.from("Synthetic launcher identity, not native proof").copy(buffer, offset);
  });
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", handle => handle === descriptor ? undefined : close(handle));
  t.mock.method(childProcess, "spawn", (executable, argv) => {
    const program = argv[argv.indexOf("--") + 2];
    const id = path.basename(program, ".mjs");
    const child = Object.assign(new EventEmitter(), { pid: 777002, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()], kill: () => true });
    let stdout = probeResponses[id] ?? "";
    if (id === "hidden-read" && hiddenReadable) stdout = stdout.replace('"hiddenReadable":false', '"hiddenReadable":true');
    if (id === "write-denied" && !scratchWritable) stdout = stdout.replace('"scratch":"written"', '"scratch":"EROFS"');
    if (id === "network-denied") stdout = `{"network":${JSON.stringify(network)}}\n`;
    const overflowing = id === "capture-bound";
    const lingering = id === "cancellation";
    if (overflowing) stdout = "x".repeat(boundedCapture ? 1024 * 1024 : 16);
    let pending = 3;
    const settle = () => { if ((pending -= 1) === 0) setImmediate(() => child.emit("close", 0, null)); };
    if (!lingering) for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream.once("end", settle);
    queueMicrotask(() => {
      if (lingering) {
        // The cancelled probe never exits on its own; only the owner's cleanup budget ends it.
        child.stdio[3].write('{"child-pid":4242}\n');
        return;
      }
      child.stdout.end(stdout);
      child.stderr.end("");
      child.stdio[3].end(overflowing ? "" : `{"child-pid":4242}\n{"exit-code":0}\n`);
    });
    return child;
  });
  syncBuiltinESMExports();
}

test("a fully observed zero-model preflight qualifies the boundary and keeps every raw reference", async t => {
  const tree = roots("checker-preflight-observed");
  preflightTransport(t);
  const preflightRoot = path.join(tree.root, "preflight");
  const receipt = await qualifyCheckerBoundary({ workRoot: preflightRoot, sourceRoot: tree.subject, controllerRoot: tree.checker, limits: { timeoutMs: 2000, maxStreamBytes: 65536, cleanupMs: 50 } });
  assert.deepEqual(receipt.checks, { isolation: true, hiddenAssertionsSeparated: true, boundedCapture: true, namespaceCleanup: true, frozenIdentities: true });
  assert.equal(receipt.status, "available");
  assert.equal(receipt.claimScope, "behavioral_outcome");
  for (const value of Object.values(receipt.identities)) assert.match(value, /^[a-f0-9]{64}$/u);
  for (const ref of receipt.evidenceRefs) assert.equal(sha256(fs.readFileSync(path.join(preflightRoot, ref.path))), ref.sha256);
  const observations = JSON.parse(fs.readFileSync(path.join(preflightRoot, "preflight-observations.json")));
  assert.deepEqual(observations.observations.map(row => row.id), ["hidden-read", "write-denied", "network-denied", "fork-setsid", "capture-bound", "cancellation"]);
  assert.equal(observations.observations.every(row => row.accepted === true), true);
  assert.equal(observations.observations.find(row => row.id === "cancellation").commandStatus, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(path.join(preflightRoot, "preflight-receipt.json"))).status, "available");
  // The materialized programs are read-only parent inputs, so argv[1] is the program and argv[2] the adversarial hidden path.
  for (const [id, program] of Object.entries(probePrograms)) {
    const materialized = fs.readFileSync(path.join(preflightRoot, `${id}-inputs`, `${id}.mjs`), "utf8");
    assert.equal(materialized, `${program}\n`, id);
    assert.equal(fs.statSync(path.join(preflightRoot, `${id}-inputs`, `${id}.mjs`)).mode & 0o777, 0o400);
  }
});

for (const [name, faults] of [
  ["a readable held-out path", { hiddenReadable: true }],
  ["an unwritable owned scratch root", { scratchWritable: false }],
  ["reachable network", { network: "connected" }],
  ["unbounded capture", { boundedCapture: false }],
]) test(`${name} refuses the preflight without degrading its claim`, async t => {
  const tree = roots(`checker-preflight-${name.replaceAll(" ", "-")}`);
  preflightTransport(t, faults);
  const receipt = await qualifyCheckerBoundary({ workRoot: path.join(tree.root, "preflight"), sourceRoot: tree.subject, controllerRoot: tree.checker, limits: { timeoutMs: 2000, maxStreamBytes: 65536, cleanupMs: 50 } });
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.claimScope, "behavioral_outcome");
  assert.equal(Object.values(receipt.checks).some(value => value === false), true);
});

test("the preflight refuses limits it cannot bound", async () => {
  const tree = roots("checker-preflight-limits");
  await assert.rejects(qualifyCheckerBoundary({ workRoot: path.join(tree.root, "preflight"), sourceRoot: tree.subject, controllerRoot: tree.checker, limits: null }), { code: "INVALID_COMMAND_LIMITS" });
});
