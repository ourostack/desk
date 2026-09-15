import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { absoluteRoot, canonicalJson, jsonBytes, listRegularFiles, overlaps, pathIdentities, plainObject, requireCondition, sha256 } from "./core.mjs";
import { captureBoundedCommand } from "./output.mjs";

// A strict allowlist: only these names may cross into candidate execution. Everything else — cloud, CI and provider
// credentials, loader hooks, coverage preloads — is refused by default rather than enumerated.
const allowedEnvNames = new Set(["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "CONFIG_FILE", "EVAL_SUBJECT_SNAPSHOT", "CHECKER_CANARY_TOKEN", "npm_config_cache", "npm_config_userconfig", "npm_config_audit", "npm_config_fund"]);
// Every admitted name also carries a field-specific value rule, so an admitted name cannot smuggle a private path.
const pathValuedEnv = new Set(["HOME", "TMPDIR", "TEMP", "TMP", "CONFIG_FILE", "EVAL_SUBJECT_SNAPSHOT", "npm_config_cache", "npm_config_userconfig"]);
const localeValuedEnv = new Set(["LANG", "LC_ALL", "LC_CTYPE"]);
const literalValuedEnv = new Map([["npm_config_audit", ["true", "false"]], ["npm_config_fund", ["true", "false"]], ["CHECKER_CANARY_TOKEN", ["untrusted-diagnostic-marker"]], ["npm_config_userconfig", ["/dev/null"]]]);

function boundaryRequired(condition, message) {
  requireCondition(condition, "CHECKER_OS_BOUNDARY_REQUIRED", message);
}

function insideRoots(value, roots) {
  if (!path.isAbsolute(value) || value.includes("\\") || value.split("/").some(part => part === "." || part === "..")) return false;
  const resolved = path.resolve(value);
  return roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function admittedEnvironmentValue(name, value, roots) {
  if (value.includes("://")) return false;
  if (literalValuedEnv.get(name)?.includes(value)) return true;
  if (name === "PATH") return value.length > 0 && value.split(path.delimiter).every(segment => insideRoots(segment, roots));
  if (pathValuedEnv.has(name)) return insideRoots(value, roots);
  if (localeValuedEnv.has(name)) return /^[A-Za-z0-9_.@-]+$/u.test(value);
  return false;
}

// Lexical normalization is not identity. A candidate-visible root must be its own canonical path with no symlinked
// ancestor, so an alias cannot resolve into held-out or parent-owned data once bwrap resolves the mount.
function canonicalRoot(value, label) {
  const root = absoluteRoot(value);
  try {
    boundaryRequired(fs.realpathSync(root) === root, `${label} must be its own canonical path, not an alias`);
    boundaryRequired(fs.lstatSync(root).isDirectory(), `${label} must be a directory`);
    pathIdentities(root);
  } catch (error) {
    boundaryRequired(error.code === "CHECKER_OS_BOUNDARY_REQUIRED", `${label} could not be identified as a safe confined directory`);
    throw error;
  }
  return root;
}

function launcherExecution(result) {
  const unavailable = { status: "unavailable" };
  if (result.status !== "exited" || result.signal !== null) return unavailable;
  try {
    const bytes = result.statusPipe.bytes.toString("utf8");
    if (!bytes.endsWith("\n")) return unavailable;
    const rows = bytes.trimEnd().split("\n").map(line => JSON.parse(line));
    if (rows.length !== 2) return unavailable;
    const pid = rows[0]?.["child-pid"];
    const exitCode = rows[1]?.["exit-code"];
    if (!Number.isSafeInteger(pid) || pid <= 0 || result.cleanup.ownedSpawns.some(row => row.pid === pid) || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || exitCode !== result.exitCode) return unavailable;
    return { status: "observed", childPid: pid, shellExitCode: exitCode, scope: "launcher-reported-initial-child-exit-only" };
  } catch { return unavailable; }
}

// A parent-side manifest of what the candidate may read. An unreadable manifest is an unfrozen observation, never an assumed-stable one.
function inputManifest(root) {
  if (root === null) return { root: null, sha256: null, files: 0 };
  try {
    const files = listRegularFiles(root);
    return { root, sha256: sha256(Buffer.from(canonicalJson(files))), files: files.length };
  } catch (error) {
    return { root, sha256: null, files: null, error: { code: error.code, message: String(error.message).slice(0, 256) } };
  }
}

function fileDigest(filename) {
  try {
    const hash = createHash("sha256");
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let count;
      while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    } finally { fs.closeSync(descriptor); }
    return hash.digest("hex");
  } catch { return null; }
}

// The parent's own view of which PID namespaces exist. Stream EOF only proves descriptors closed; a descendant that
// closed its inherited descriptors would still hold its namespace open, and that is what this snapshot detects.
function pidNamespaceSnapshot() {
  const namespaces = new Set();
  let unreadable = 0;
  let listed = [];
  try { listed = fs.readdirSync("/proc").filter(name => /^\d+$/u.test(name)).slice(0, 16384); }
  catch { unreadable += 1; }
  for (const name of listed) {
    try { namespaces.add(fs.readlinkSync(`/proc/${name}/ns/pid`)); }
    catch (error) { unreadable += Number(error.code !== "ENOENT"); }
  }
  return { namespaces: [...namespaces], unreadable };
}

function survivingNamespaces(before, after) {
  return after.namespaces.filter(namespace => !before.namespaces.includes(namespace));
}

// A retired init is one the parent can no longer find, or one whose PID now belongs to a namespace that predates this run.
function initRetired(childPid, before) {
  try { return before.namespaces.includes(fs.readlinkSync(`/proc/${childPid}/ns/pid`)); }
  catch { return true; }
}

async function reconcileNamespaceLifetime(before, execution) {
  let after = pidNamespaceSnapshot();
  for (let attempt = 0; attempt < 4 && survivingNamespaces(before, after).length > 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    after = pidNamespaceSnapshot();
  }
  const surviving = survivingNamespaces(before, after);
  const retired = execution.status === "observed" ? initRetired(execution.childPid, before) : null;
  return {
    scope: "parent-observed-pid-namespace-reconciliation",
    initPid: execution.status === "observed" ? execution.childPid : null,
    initRetired: retired,
    survivingNamespaces: surviving,
    unreadable: before.unreadable + after.unreadable,
    observedBefore: before.namespaces.length,
    observedAfter: after.namespaces.length,
    reconciled: before.unreadable === 0 && after.unreadable === 0 && before.namespaces.length > 0 && surviving.length === 0 && retired !== false,
  };
}

// A PID namespace, not a process group: setsid/double-fork cannot escape its init's lifetime.
export async function captureConfinedChecker({ executable, argv, cwd, env, limits, signal, workRoot, subject, checkerRoot, inputsRoot, scratchRoot }) {
  boundaryRequired(process.platform === "linux", "Checker execution requires Linux user/mount/PID/network namespaces and the owned bubblewrap launcher; controller-identity execution is forbidden");
  const launcher = "/usr/bin/bwrap";
  let identity;
  try { identity = fs.lstatSync(launcher); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    boundaryRequired(false, "The maintained /usr/bin/bwrap namespace launcher is unavailable");
  }
  boundaryRequired(identity.isFile() && identity.uid === 0 && (identity.mode & 0o6022) === 0, "The checker launcher must be a root-owned non-setid executable, not a link or writable candidate");
  const launcherSha256 = sha256(fs.readFileSync(launcher));
  const parentRoot = canonicalRoot(workRoot, "The parent work root");
  const source = canonicalRoot(subject, "The candidate source root");
  // Held-out assertions, expected matrices and parent evidence live here and are never mounted.
  const hidden = canonicalRoot(checkerRoot, "The held-out checker root");
  const inputs = inputsRoot === undefined || inputsRoot === null ? null : canonicalRoot(inputsRoot, "The parent-owned inputs root");
  const requestedScratch = absoluteRoot(scratchRoot ?? path.join(parentRoot, "child-scratch"));
  fs.mkdirSync(requestedScratch, { recursive: true, mode: 0o700 });
  const scratch = canonicalRoot(requestedScratch, "The child-owned scratch root");
  // Mode 0700 stays usable inside the sandbox because bwrap maps this caller's uid onto the requested sandbox uid,
  // so roots this process owns are owned by that uid in the namespace. Roots owned by another user are not usable.
  const candidateRoots = [source, ...(inputs ? [inputs] : []), scratch];
  boundaryRequired(candidateRoots.every(root => !overlaps(root, hidden)), "The held-out checker root cannot overlap any root the candidate can reach");
  boundaryRequired(candidateRoots.every((root, index) => candidateRoots.slice(index + 1).every(other => !overlaps(root, other))), "Candidate source, inputs and scratch must be separate roots");
  // An ancestor bind exposes the parent work root just as wholesale as binding it directly; owned descendants stay legal.
  boundaryRequired(candidateRoots.every(root => root !== parentRoot && !parentRoot.startsWith(`${root}${path.sep}`)), "No candidate mount may be the parent work root or contain it");
  const directory = absoluteRoot(cwd);
  boundaryRequired(candidateRoots.some(root => directory === root || directory.startsWith(`${root}${path.sep}`)), "The candidate working directory must be inside its mounted source, inputs or scratch root");
  const runtimeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  const mounts = [...new Set(["/usr", "/bin", "/lib", "/lib64", runtimeRoot].filter(root => fs.existsSync(root)))];
  boundaryRequired(mounts.every(root => root !== "/" && [parentRoot, hidden, ...candidateRoots].every(other => !overlaps(root, other))), "Runtime mounts must be separate from all candidate, parent and checker inputs");
  const reachableRoots = [...mounts, ...candidateRoots];
  for (const [name, value] of Object.entries(env)) {
    boundaryRequired(allowedEnvNames.has(name), `Environment ${name} is not on the candidate boundary's allowlist`);
    boundaryRequired(!value.includes(hidden), `Environment ${name} cannot name a held-out path`);
    boundaryRequired(admittedEnvironmentValue(name, value, reachableRoots), `Environment ${name} carries a value outside its declared field rule`);
  }
  // Required inputs must be identified before the transport, not diagnosed after the candidate has already read them.
  const before = { source: inputManifest(source), inputs: inputManifest(inputs) };
  boundaryRequired(before.source.sha256 !== null, "The candidate source manifest must be readable before execution");
  boundaryRequired(inputs === null || before.inputs.sha256 !== null, "The parent-owned inputs manifest must be readable before execution");
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--uid", "65534", "--gid", "65534", "--clearenv"];
  // bwrap closes this monitor-only descriptor in the sandbox child before exec.
  args.push("--json-status-fd", "3");
  for (const root of mounts) args.push("--ro-bind", root, root);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", source, source);
  if (inputs) args.push("--ro-bind", inputs, inputs);
  args.push("--bind", scratch, scratch, "--chdir", directory);
  for (const [name, value] of Object.entries(env)) args.push("--setenv", name, value);
  const mountArgs = [...args];
  args.push("--", executable, ...argv);
  const namespacesBefore = pidNamespaceSnapshot();
  const result = await captureBoundedCommand({ executable: launcher, argv: args, cwd: parentRoot, env: { PATH: "/usr/bin:/bin" }, limits, signal, statusPipe: true });
  const after = { source: inputManifest(source), inputs: inputManifest(inputs) };
  const execution = launcherExecution(result);
  const lifetime = await reconcileNamespaceLifetime(namespacesBefore, execution);
  const readOnly = mountArgs.flatMap((value, index) => value === "--ro-bind" ? [mountArgs[index + 1]] : []);
  const writable = mountArgs.flatMap((value, index) => value === "--bind" ? [mountArgs[index + 1]] : []);
  const statusPipeEof = result.statusPipe.eof === true;
  // Descriptor EOF alone cannot close a namespace: the parent must also observe that no namespace this run created survives.
  const namespaceClosed = result.status === "exited" && result.signal === null && result.captureComplete === true && statusPipeEof && execution.status === "observed" && lifetime.reconciled;
  const facts = {
    // Endpoint manifest equality across the run, not continuous immutability: it refuses inputs that differ at the
    // capture points and cannot exclude a trusted-side writer that mutates and restores them mid-run.
    frozenInputs: before.source.sha256 === after.source.sha256 && before.inputs.sha256 === after.inputs.sha256,
    isolatedSourceAndInputsOnly: writable.length === 1 && writable[0] === scratch && readOnly.length === mounts.length + 1 + (inputs ? 1 : 0) && readOnly.includes(source) && (!inputs || readOnly.includes(inputs)),
    hiddenAssertionsNotMounted: [...readOnly, ...writable].every(root => !overlaps(root, hidden)) && !mountArgs.includes(hidden) && !mountArgs.includes(parentRoot),
    captureWithinLimits: ![result.stdout, result.stderr, result.statusPipe].some(channel => channel.truncated) && !["COMMAND_OUTPUT_OVERFLOW", "COMMAND_CAPTURE_OVERFLOW"].includes(result.failure?.code),
    commandExitObserved: result.status === "exited" && Number.isInteger(result.exitCode) && result.signal === null,
    statusPipeEof,
    namespaceClosed,
    // Cleanup reconciliation is independent of whether the command itself succeeded, timed out or was cancelled.
    cleanupComplete: result.cleanup.unverifiedPids.length === 0 && result.cleanup.ownedSpawns.length > 0 && result.cleanup.exitObservations.length === result.cleanup.ownedSpawns.length && lifetime.reconciled,
  };
  const rawRefs = Object.fromEntries(["stdout", "stderr", "statusPipe"].map(name => [name, { channel: name, sha256: result[name].sha256, byteLength: result[name].byteLength, chunks: result[name].chunks, truncated: result[name].truncated, eof: result[name].eof }]));
  return {
    ...result, statusPipeEof, namespaceClosed, lifetime,
    // The launcher reports child exit, not a kernel exec event, assertion, identity or descendant proof.
    launcher: { path: launcher, sha256: launcherSha256, identityScope: "prelaunch-file-only", namespace: "user,mount,pid,network,ipc,uts", execution, nativeQualified: false },
    boundary: { readOnly, writable, hiddenRoots: [hidden, parentRoot], chdir: directory, inputs: { sourceManifestSha256: before.source.sha256, sourceManifestSha256After: after.source.sha256, inputsManifestSha256: before.inputs.sha256, inputsManifestSha256After: after.inputs.sha256 } },
    availability: { ...facts, available: Object.values(facts).every(Boolean), rawRefs, scope: "observed-boundary-facts-not-attestation", frozenInputsScope: "endpoint-manifest-equality" },
  };
}

const probes = [
  {
    id: "hidden-read",
    // The child is given the actual parent-only path as an adversarial probe, never its contents.
    program: `import fs from "node:fs";
process.stdout.write(JSON.stringify({
  hiddenReadable: fs.existsSync(process.argv[2]),
  hasNodeOptions: Object.hasOwn(process.env, "NODE_OPTIONS"),
  hasNodePath: Object.hasOwn(process.env, "NODE_PATH"),
  hasCoverage: Object.hasOwn(process.env, "NODE_V8_COVERAGE"),
  environment: Object.keys(process.env).sort(),
}) + "\\n");`,
    accept: value => value.hiddenReadable === false && value.hasNodeOptions === false && value.hasNodePath === false && value.hasCoverage === false,
    contributes: ["hiddenAssertionsSeparated"],
  },
  {
    id: "write-denied",
    program: `import fs from "node:fs";
const attempt = target => { try { fs.writeFileSync(target, "candidate"); return "written"; } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({ source: attempt(process.argv[3]), inputs: attempt(process.argv[4]), scratch: attempt(process.argv[5]) }) + "\\n");`,
    accept: value => value.source !== "written" && value.inputs !== "written" && value.scratch === "written",
    contributes: ["isolation"],
  },
  {
    id: "network-denied",
    program: `import net from "node:net";
const done = network => { process.stdout.write(JSON.stringify({ network }) + "\\n"); process.exit(0); };
const socket = net.connect(443, "93.184.216.34");
socket.setTimeout(2000, () => done("timeout"));
socket.on("error", error => done(error.code));
socket.on("connect", () => done("connected"));`,
    accept: value => typeof value.network === "string" && value.network !== "connected",
    contributes: ["isolation"],
  },
  {
    id: "fork-setsid",
    program: `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
child.unref();
process.stdout.write(JSON.stringify({ escapedPid: child.pid }) + "\\n");`,
    accept: value => Number.isSafeInteger(value.escapedPid) && value.escapedPid > 0,
    contributes: ["namespaceCleanup"],
  },
  {
    id: "fork-silent",
    // This descendant closes every inherited descriptor, so stream EOF arrives while it is still alive:
    // only the parent's namespace reconciliation can show that it did not outlive the namespace.
    program: `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30000)"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
child.unref();
process.stdout.write(JSON.stringify({ silentPid: child.pid }) + "\\n");`,
    accept: value => Number.isSafeInteger(value.silentPid) && value.silentPid > 0,
    contributes: ["namespaceCleanup"],
  },
  {
    id: "capture-bound",
    program: `process.stdout.write("x".repeat(1024 * 1024));`,
    limits: { maxStreamBytes: 4096 },
    expect: result => result.stdout.truncated === true && result.stdout.byteLength <= 4096 && result.availability.captureWithinLimits === false && result.availability.available === false,
    contributes: ["boundedCapture"],
  },
  {
    id: "cancellation",
    program: `setInterval(() => {}, 1000);`,
    cancel: true,
    expect: result => result.status === "cancelled" && result.namespaceClosed === false && result.availability.available === false,
    contributes: ["namespaceCleanup"],
  },
];

// Zero-model observations under a frozen boundary. Not a cryptographic attestation of the runtime.
export async function qualifyCheckerBoundary({ workRoot, sourceRoot, controllerRoot, limits, signal }) {
  const root = absoluteRoot(workRoot);
  const source = absoluteRoot(sourceRoot);
  const controller = absoluteRoot(controllerRoot);
  requireCondition(plainObject(limits), "INVALID_COMMAND_LIMITS", "The checker preflight requires explicit capture and execution bounds");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidenceRefs = [];
  const retain = (name, bytes) => {
    fs.writeFileSync(path.join(root, name), bytes, { flag: "w", mode: 0o600 });
    evidenceRefs.push({ path: name, sha256: sha256(bytes) });
  };
  const identities = () => ({ controllerSha256: inputManifest(controller).sha256, runtimeSha256: fileDigest(process.execPath), launcherSha256: fileDigest("/usr/bin/bwrap"), sourceManifestSha256: inputManifest(source).sha256 });
  const identitiesBefore = identities();
  // The candidate reaches the runtime through its canonical mounted path, never through an unmounted launcher alias.
  const runtime = fs.realpathSync(process.execPath);
  const observations = [];
  for (const probe of probes) {
    // Caller cancellation stops the preflight from creating any further child, including the last probe.
    const observation = { id: probe.id, contributes: probe.contributes, accepted: false, started: false, cleanupReconciled: false };
    if (signal?.aborted) {
      Object.assign(observation, { status: "unavailable", reason: "CALLER_CANCELLED_BEFORE_PROBE" });
      retain(`${probe.id}-probe.json`, jsonBytes(observation));
      observations.push(observation);
      continue;
    }
    const scratch = path.join(root, `${probe.id}-scratch`);
    const inputs = path.join(root, `${probe.id}-inputs`);
    fs.mkdirSync(inputs, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(inputs, "public-input.json"), jsonBytes({ probe: probe.id, kind: "public-input" }), { flag: "w", mode: 0o600 });
    const cancellation = probe.cancel ? new AbortController() : null;
    // The probe's own cancellation composes with the caller's; it never replaces it.
    const composed = cancellation ? AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]) : signal;
    // The frozen probe program is a parent-owned, read-only input, so argv[1] is the program and argv[2] is the adversarial hidden path.
    const program = path.join(inputs, `${probe.id}.mjs`);
    fs.writeFileSync(program, Buffer.from(`${probe.program}\n`), { flag: "w", mode: 0o400 });
    observation.started = true;
    try {
      const pending = captureConfinedChecker({
        executable: runtime,
        argv: [program, controller, path.join(source, ".candidate-write-probe"), path.join(inputs, "public-input.json"), path.join(scratch, "candidate-write-probe")],
        cwd: scratch, env: { HOME: scratch, PATH: `${path.dirname(runtime)}:/usr/bin:/bin` },
        limits: { ...limits, ...probe.limits }, signal: composed,
        workRoot: root, subject: source, checkerRoot: controller, inputsRoot: inputs, scratchRoot: scratch,
      });
      if (cancellation) setTimeout(() => cancellation.abort(), 100);
      const result = await pending;
      retain(`${probe.id}-stdout.raw`, result.stdout.bytes);
      retain(`${probe.id}-stderr.raw`, result.stderr.bytes);
      retain(`${probe.id}-status.raw`, result.statusPipe.bytes);
      let parsed = null;
      try { parsed = JSON.parse(result.stdout.bytes.toString("utf8")); } catch { parsed = null; }
      // Whether the command succeeded, overflowed or was cancelled is separate from whether its resources reconciled.
      const cleanupReconciled = result.availability.cleanupComplete === true && result.lifetime.reconciled === true;
      Object.assign(observation, {
        status: result.availability.available ? "available" : "unavailable",
        exitCode: result.exitCode, commandStatus: result.status, captureComplete: result.captureComplete,
        statusPipeEof: result.statusPipeEof, namespaceClosed: result.namespaceClosed, cleanupReconciled,
        availability: result.availability, boundary: result.boundary, cleanup: result.cleanup, lifetime: result.lifetime,
        launcher: { path: result.launcher.path, sha256: result.launcher.sha256, execution: result.launcher.execution, nativeQualified: false },
        parsedCandidateOutput: parsed,
        // Candidate output is read only where the parent already observed an available, complete, closed run.
        accepted: cleanupReconciled && (probe.expect
          ? probe.expect(result)
          : result.availability.available === true && result.exitCode === 0 && parsed !== null && probe.accept(parsed)),
      });
    } catch (error) {
      Object.assign(observation, { status: "unavailable", error: { code: error.code, message: String(error.message).slice(0, 256) } });
    }
    retain(`${probe.id}-probe.json`, jsonBytes(observation));
    observations.push(observation);
  }
  const identitiesAfter = identities();
  const contributed = name => {
    const rows = observations.filter(row => row.contributes.includes(name));
    return rows.length > 0 && rows.every(row => row.accepted === true);
  };
  // Every probe the preflight actually started must have reconciled its owned resources, including the expected
  // overflow and cancellation failures, before any qualification can be claimed.
  const startedProbesReconciled = observations.every(row => row.started === false || row.cleanupReconciled === true) && observations.some(row => row.started);
  const checks = {
    isolation: contributed("isolation"),
    hiddenAssertionsSeparated: contributed("hiddenAssertionsSeparated") && observations.every(row => row.availability === undefined || row.availability.hiddenAssertionsNotMounted === true),
    boundedCapture: contributed("boundedCapture"),
    namespaceCleanup: contributed("namespaceCleanup") && startedProbesReconciled,
    frozenIdentities: canonicalJson(identitiesBefore) === canonicalJson(identitiesAfter) && Object.values(identitiesBefore).every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)),
  };
  retain("preflight-observations.json", jsonBytes({ schemaVersion: 1, identitiesBefore, identitiesAfter, observations }));
  const receipt = { schemaVersion: 1, status: Object.values(checks).every(Boolean) ? "available" : "unavailable", claimScope: "behavioral_outcome", identities: identitiesBefore, checks, evidenceRefs };
  fs.writeFileSync(path.join(root, "preflight-receipt.json"), jsonBytes(receipt), { flag: "w", mode: 0o600 });
  return receipt;
}

// The controller owns this dependency. Test transports replace it only in the test process.
export const checkerProcess = { capture: captureConfinedChecker, qualify: qualifyCheckerBoundary };
