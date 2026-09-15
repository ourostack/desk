import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { canonicalJson, hashString, listRegularFiles, parseRawJson, plainObject, readRawReference, readRegular, relativeName, requireCondition, sha256 } from "./core.mjs";

function sourceGit(root, argv, encoding = "utf8", timeoutMs = 10000) {
  let metadata;
  try { metadata = fs.lstatSync(path.join(root, ".git")); }
  catch (error) {
    requireCondition(!["ENOENT", "ENOTDIR"].includes(error.code), "CHECK_SOURCE_IDENTITY_UNAVAILABLE", "The delivered fixture has no Git metadata directory");
    throw error;
  }
  requireCondition(metadata.isDirectory() && !["commondir", "objects/info/alternates", "info/grafts"].some(name => fs.existsSync(path.join(root, ".git", name))), "CHECK_SOURCE_IDENTITY_UNAVAILABLE", "The fixture must own its Git metadata and object store without redirects");
  try {
    return execFileSync("git", ["--no-optional-locks", "--no-replace-objects", "--git-dir", path.join(root, ".git"), "--work-tree", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...argv], {
      encoding, timeout: timeoutMs, maxBuffer: 16777216,
      env: { PATH: process.env.PATH, HOME: root, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const diagnostic = String(error.stderr ?? "");
    const dataInvalid = /not a git repository|bad config line|index file (?:smaller than expected|corrupt)|bad signature|bad object|not a (?:tree|commit) object|not a valid object name|unable to read (?:tree \()?[a-f0-9]{40}|unknown revision|(?:loose|packed) object .* is corrupt|object file .* is empty|inflate: data stream error/i.test(diagnostic);
    const hostFault = /input\/output error|i\/o error|permission denied|operation not permitted|out of memory|cannot allocate memory|too many open files|resource temporarily unavailable|no space left|read-only file system/i.test(diagnostic);
    // Exit status alone cannot distinguish bad repository bytes from an actual host/tool failure.
    if (error.code === undefined && error.status === 128 && error.signal === null && dataInvalid && !hostFault) {
      throw Object.assign(new Error("The delivered Git metadata or objects are invalid"), { code: "CHECK_SOURCE_IDENTITY_UNAVAILABLE", cause: error });
    }
    throw error;
  }
}

export function readSourceState({ root, files = listRegularFiles(root), baseCommit, retain }) {
  const sourceCommit = sourceGit(root, ["rev-parse", "HEAD"]).trim();
  const [name, email] = sourceGit(root, ["show", "-s", "--format=%cn%n%ce", "HEAD"]).trim().split("\n");
  // Git worktree status/diff can run candidate clean filters even with --no-ext-diff. Read raw tree/index objects and compare the frozen descriptors ourselves.
  const tree = sourceGit(root, ["ls-tree", "-rz", "--full-tree", sourceCommit]).split("\0").filter(Boolean).map(record => {
    const match = /^([0-7]+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    requireCondition(match, "CHECK_SOURCE_IDENTITY_UNAVAILABLE", "The fixture commit must contain regular source blobs");
    return { mode: Number.parseInt(match[1], 8) & 0o777, blob: match[2], path: match[3] };
  });
  const index = new Map(sourceGit(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map(record => {
    const match = /^([0-7]+) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(record);
    requireCondition(match, "CHECK_SOURCE_IDENTITY_UNAVAILABLE", "Unresolved Git index stages cannot identify committed fixture source");
    return [match[3], { mode: Number.parseInt(match[1], 8) & 0o777, blob: match[2] }];
  }));
  const diff = sourceGit(root, ["diff-tree", "--root", "--no-commit-id", "--no-ext-diff", "--no-textconv", "-p", ...(baseCommit ? [baseCommit] : []), sourceCommit, "--"]);
  const committed = {};
  const changes = [];
  const statusRows = [];
  const display = filename => /[\n\r\t"]/.test(filename) ? JSON.stringify(filename) : filename;
  const digests = new Map();
  const digest = blob => {
    if (!digests.has(blob)) digests.set(blob, sha256(sourceGit(root, ["cat-file", "blob", blob], null)));
    return digests.get(blob);
  };
  for (const member of tree) committed[member.path] = digest(member.blob);
  for (const filename of new Set([...tree.map(member => member.path), ...index.keys()])) {
    const head = tree.find(member => member.path === filename);
    const staged = index.get(filename);
    const actual = files.find(file => file.path === filename);
    const indexSha256 = staged ? digest(staged.blob) : null;
    const first = !head ? "A" : !staged ? "D" : head.blob !== staged.blob || head.mode !== staged.mode ? "M" : " ";
    const second = !staged ? " " : !actual ? "D" : actual.sha256 !== indexSha256 || (actual.mode & 0o111 ? 0o755 : 0o644) !== staged.mode ? "M" : " ";
    if (first !== " " || second !== " ") {
      changes.push({ path: filename, committedSha256: committed[filename] ?? null, indexSha256, observedSha256: actual?.sha256 ?? null });
      statusRows.push(`${first}${second} ${display(filename)}`);
    }
  }
  // Fixed fixtures have no ignore rules. Future ignored-output policy must be explicit; candidate .gitignore files cannot suppress delivered-byte evidence.
  for (const member of files.filter(file => !file.path.startsWith(".git/") && !index.has(file.path))) {
    statusRows.push(`?? ${display(member.path)}`);
    if (!tree.some(row => row.path === member.path)) changes.push({ path: member.path, committedSha256: null, indexSha256: null, observedSha256: member.sha256 });
  }
  const value = { sourceCommit, status: statusRows.join("\n"), files, diff, changes, committed, committer: { name, email } };
  return { ...value, rawRef: retain("source-state.json", value) };
}

// tar consumes a bounded, descriptor-verified byte snapshot on stdin; it never reopens a candidate pathname or extracts into the parent.
export function inspectArchive({ root, archive, sourceCommit, retain }) {
  const started = performance.now();
  const inspection = { maxProcesses: 32, totalMs: 10000, processes: 0 };
  const budget = (requests = 1) => {
    const remaining = inspection.totalMs - (performance.now() - started);
    requireCondition(inspection.processes + requests <= inspection.maxProcesses && remaining > 0, "ARCHIVE_INSPECTION_LIMIT", "Archive inspection exhausted its aggregate process or time budget");
    return Math.max(1, Math.ceil(remaining));
  };
  const file = readRegular(root, archive.path);
  requireCondition(file.sha256 === archive.sha256, "CHECK_SOURCE_CHANGED", "The delivered archive changed after its inventory");
  const run = args => {
    const timeout = budget();
    inspection.processes++;
    return execFileSync("tar", args, { input: file.bytes, timeout, maxBuffer: 16777216, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
  };
  const committedDigest = filename => {
    const timeout = budget();
    inspection.processes++;
    return sha256(sourceGit(root, ["show", `${sourceCommit}:${filename}`], null, timeout));
  };
  const evidence = { archiveSha256: file.sha256, sourceCommit, descriptorIdentity: file.identity, members: [], inspection };
  try {
    const names = run(["-tzf", "-"]).toString("utf8").trimEnd().split("\n");
    const types = run(["-tvzf", "-"]).toString("utf8").trimEnd().split("\n").map(line => line[0]);
    requireCondition(names.length <= 4096 && new Set(names).size === names.length && types.length === names.length && types.every(type => type === "-" || type === "d"), "ARCHIVE_INVALID", "Archive members must be unique regular files or directories");
    // Account for every member extraction and both fixed Git reads before paying for the member loop.
    budget(types.filter(type => type === "-").length + 2);
    for (const name of names) {
      const relative = name.endsWith("/") ? name.slice(0, -1) : name;
      relativeName(relative);
      requireCondition(relative === "package" || relative.startsWith("package/"), "ARCHIVE_INVALID", "Archive members must stay inside package/");
    }
    let totalBytes = 0;
    let descriptionBytes;
    for (const [index, name] of names.entries()) {
      if (types[index] === "d") continue;
      const bytes = run(["-xzOf", "-", name]);
      totalBytes += bytes.length;
      requireCondition(totalBytes <= 16777216, "ARCHIVE_INVALID", "Archive contents exceed the fixed decoded-byte bound");
      evidence.members.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
      if (name === "package/package.json") descriptionBytes = bytes;
    }
    requireCondition(descriptionBytes, "ARCHIVE_INVALID", "The delivered archive has no package manifest");
    const description = JSON.parse(descriptionBytes);
    requireCondition(plainObject(description) && description.name === "packed-delivery-fixture" && typeof description.exports === "string" && description.exports.startsWith("./"), "ARCHIVE_INVALID", "The fixed package requires its direct public export");
    const entry = relativeName(description.exports.slice(2));
    const member = evidence.members.find(value => value.path === `package/${entry}`);
    requireCondition(member, "ARCHIVE_INVALID", "The declared public entry must exist inside the delivered archive");
    Object.assign(evidence, {
      status: "observed", entry, entrySha256: member.sha256, packageSha256: sha256(descriptionBytes),
      sourceSha256: readRegular(root, "src/retry-policy.mjs").sha256, sourcePackageSha256: readRegular(root, "package.json").sha256,
      committedSourceSha256: committedDigest("src/retry-policy.mjs"),
      committedPackageSha256: committedDigest("package.json"),
    });
    budget(0);
  } catch (error) {
    const invalidArchive = ["ARCHIVE_INVALID", "INVALID_PATH"].includes(error.code) || error instanceof SyntaxError || error.code === undefined && Number.isInteger(error.status) && error.status !== 0;
    if (!invalidArchive) {
      Object.assign(evidence, { status: "unavailable", reason: error.code });
      inspection.elapsedMs = performance.now() - started;
      const rawRef = retain("archive-members.json", evidence);
      throw Object.assign(new Error("Archive inspection could not obtain bounded source-system evidence"), { code: "CHECK_ARTIFACT_UNAVAILABLE", cause: error, rawRef });
    }
    Object.assign(evidence, { status: "invalid", reason: error.code ?? "ARCHIVE_INVALID" });
  }
  inspection.elapsedMs = performance.now() - started;
  return { ...evidence, rawRef: retain("archive-members.json", evidence) };
}

function parseReviewJson(bytes) {
  let value;
  try { value = parseRawJson(bytes); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error("Retained native review JSON is malformed"), { code: "REVIEW_READBACK_INVALID", cause: error });
  }
  requireCondition(plainObject(value), "REVIEW_READBACK_INVALID", "A native review record must be an object");
  return value;
}

function readReviewJson(ref, readArtifact) {
  if (ref === undefined || ref === null || typeof readArtifact !== "function") return null;
  let bytes;
  try {
    bytes = readRawReference(ref, name => {
      const value = readArtifact(name);
      requireCondition(value !== undefined && value !== null, "REVIEW_ARTIFACT_ABSENT", "The native review artifact is absent");
      return value;
    });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "REVIEW_ARTIFACT_ABSENT"].includes(error.code)) return null;
    throw error;
  }
  return parseReviewJson(bytes);
}

function reviewReadback(review, readArtifact) {
  if (!review) return null;
  const execution = readReviewJson(review.value?.rawRef, readArtifact);
  const admission = readReviewJson(review.admissionRef, readArtifact);
  if (execution === null || admission === null) return null;
  const { record } = admission;
  requireCondition(plainObject(record) && plainObject(admission.admitted) && record.rawRef !== undefined && typeof record.sha === "string" && typeof record.reviewerSessionId === "string"
    && typeof execution.sha === "string" && typeof execution.sessionId === "string" && Array.isArray(execution.argv) && Array.isArray(record.argv)
    && typeof execution.outputBase64 === "string" && typeof execution.drainedFully === "boolean" && (execution.failure === null || plainObject(execution.failure))
    && hashString(record.outputSha256), "REVIEW_READBACK_INVALID", "Native execution and admission records are incomplete or malformed");
  requireCondition(execution.sha === record.sha && execution.sessionId === review.sessionId
    && sha256(Buffer.from(execution.outputBase64, "base64")) === record.outputSha256
    && canonicalJson(execution.argv) === canonicalJson(record.argv)
    && canonicalJson(admission.rawRef) === canonicalJson(review.value.rawRef), "REVIEW_READBACK_CHANGED", "Native review source, session, command or output identities disagree");
  const session = readReviewJson(record.rawRef, readArtifact);
  if (session === null) return null;
  requireCondition(typeof session.base64 === "string" && hashString(session.sha256), "REVIEW_READBACK_INVALID", "The retained reviewer session has no valid byte identity");
  const bytes = Buffer.from(session.base64, "base64");
  requireCondition(sha256(bytes) === session.sha256, "REVIEW_READBACK_CHANGED", "Reviewer session bytes differ from their retained identity");
  // Explicit native execution failures or missing completion are unavailable evidence, not integrity or parsing errors.
  if (!execution.drainedFully || execution.failure) return null;
  const result = execution.result;
  requireCondition(plainObject(result) && plainObject(result.result)
    && (Number.isInteger(result.result.code) && result.result.signal === null || result.result.code === null && typeof result.result.signal === "string")
    && Array.isArray(result.survived) && Array.isArray(result.unverified), "REVIEW_READBACK_INVALID", "Native reviewer completion is malformed");
  if (result.result.code !== 0 || result.cleanupError || result.timedOut || result.survived.length !== 0 || result.unverified.length !== 0) return null;
  const text = bytes.toString("utf8").trimEnd();
  if (!text) return null;
  const events = text.split("\n").map(line => parseReviewJson(Buffer.from(line)));
  requireCondition(events.some(event => event.type === "session.start" && event.data?.sessionId === record.reviewerSessionId), "REVIEW_READBACK_CHANGED", "Reviewer events do not belong to the declared native session");
  if (!events.some(event => event.type === "assistant.message" && !event.agentId && typeof event.data?.content === "string" && event.data.content.trim())) return null;
  return { sourceCommit: record.sha, reviewerSessionId: record.reviewerSessionId, subjectSessionId: review.sessionId, findings: admission.admitted.findings, admitted: admission.admitted.admitted, executionRef: review.value.rawRef, admissionRef: review.admissionRef, sessionRef: record.rawRef };
}

// Exact program recognition, not keyword detection. Unknown consumer code remains unavailable.
const consumerPrograms = new Set([
  'import { retryAttempts } from "packed-delivery-fixture"; console.log(retryAttempts(), retryAttempts(5), retryAttempts(0));',
  "import { retryAttempts } from 'packed-delivery-fixture'; console.log(retryAttempts(), retryAttempts(5), retryAttempts(0));",
]);
export function observeAuthority({ trace, root, probe }) {
  requireCondition(Array.isArray(trace.operations), "TRACE_AUTHORITY_UNAVAILABLE", "Authority requires the actual ordered syscall operations, not a mutation summary");
  const tables = new Map();
  const table = pid => {
    if (!tables.has(pid)) tables.set(pid, new Map([[0, null], [1, null], [2, null]]));
    return tables.get(pid);
  };
  let sourceWrite = false;
  let authorityWrite = false;
  let unresolved = false;
  const observe = filename => {
    if (filename === null) return;
    if (filename === probe) { unresolved = true; return; }
    if (typeof filename !== "string" || !path.isAbsolute(filename)) { unresolved = true; return; }
    filename = path.normalize(filename);
    if (filename === root || filename.startsWith(`${root}/`) && !filename.startsWith(`${root}/.git/`) && filename !== `${root}/.git`) sourceWrite = true;
    else authorityWrite = true;
  };
  for (const event of [...trace.operations].sort((a, b) => a.timestamp - b.timestamp)) {
    const { call, args, result, pid } = event;
    const failed = result.startsWith("-1");
    const fds = table(pid);
    const descriptor = Number(args.split(",")[0].split("<")[0]);
    const returned = Number(/^(0x[0-9a-f]+|\d+)/.exec(result)?.[0]);
    const names = () => [...args.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(match[0]));
    if (["clone", "clone3", "fork", "vfork"].includes(call)) {
      if (!failed) tables.set(returned, args.includes("CLONE_FILES") ? fds : new Map(fds));
    } else if (["execve", "execveat"].includes(call)) {
      if (failed) continue;
      for (const fd of fds.keys()) if (fd > 2) fds.delete(fd);
    }
    else if (["open", "openat", "openat2", "creat"].includes(call)) {
      const filename = /<([^>]+)>/.exec(result)?.[1] ?? names()[0];
      if (!failed) fds.set(returned, filename);
      if (call === "creat" || /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_EXCL/.test(args)) observe(filename);
    } else if (["socket", "accept", "accept4"].includes(call)) {
      if (!failed) fds.set(returned, undefined);
    }
    else if (["pipe", "pipe2", "socketpair"].includes(call)) {
      if (failed) continue;
      const descriptors = /\[(\d+),\s*(\d+)\]/.exec(args);
      requireCondition(descriptors, "TRACE_AUTHORITY_UNAVAILABLE", "The actual descriptor pair must be decoded");
      for (const fd of descriptors.slice(1)) fds.set(Number(fd), null);
    } else if (call === "close") { if (!failed) fds.delete(descriptor); }
    else if (call === "close_range") {
      if (failed) continue;
      const upper = Number(args.split(",")[1]);
      for (const fd of fds.keys()) if (fd >= descriptor && fd <= upper) fds.delete(fd);
    }
    else if (["dup", "dup2", "dup3"].includes(call) || call === "fcntl" && args.includes("F_DUPFD")) { if (!failed) fds.set(returned, fds.get(descriptor)); }
    else if (/^(ftruncate|fallocate|fchmod|fchown)$/.test(call) || /^(write|writev|pwrite64|pwritev|pwritev2)$/.test(call)) observe(fds.get(descriptor));
    else if (/^(rename|renameat|renameat2|unlink|unlinkat|mkdir|mkdirat|rmdir|link|linkat|symlink|symlinkat|chmod|fchmodat|chown|lchown|fchownat|utime|utimes|utimensat|truncate)$/.test(call)) {
      const filenames = names();
      if (filenames.length === 0) unresolved = true;
      for (const name of filenames) observe(name);
    } else if (!["access", "faccessat", "faccessat2", "stat", "lstat", "fstat", "newfstatat", "statx", "readlink", "readlinkat", "getcwd", "chdir", "fchdir", "execve", "execveat"].includes(call)) unresolved = true;
  }
  return { sourceWrite, authorityWrite, unresolved };
}
export function observePackagePipeline({ trace, retain }) {
  if (!trace) return {};
  const pipelineCandidates = [];
  let unknownConsumer = false;
  for (const event of [...trace.executions].sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.result !== "0") continue;
    let argv;
    let executable;
    try {
      const match = /^("(?:[^"\\]|\\.)*"),\s*(\[.*\]),\s/.exec(event.args);
      executable = JSON.parse(match?.[1]);
      argv = JSON.parse(match?.[2]);
    }
    catch { unknownConsumer = true; continue; }
    if (!Array.isArray(argv) || !argv.every(value => typeof value === "string") || !path.isAbsolute(executable)) { unknownConsumer = true; continue; }
    const node = [process.execPath, "/usr/bin/node", "/bin/node"].includes(executable);
    const npm = /^(\/usr\/bin\/npm|\/usr\/local\/bin\/npm)$/.test(executable) ? 0 : node && /\/npm-cli\.js$/.test(argv[1]) ? 1 : -1;
    let step;
    if (npm !== -1) {
      const args = argv.slice(npm + 1);
      if (args[0] === "run" && args[1] === "build") step = "build";
      if (args[0] === "pack") step = "pack";
      if (args[0] === "install" && args.some(arg => arg.endsWith(".tgz"))) step = "install";
    } else if (node) {
      const expression = argv[argv.indexOf("-e") + 1];
      if (argv.includes("-e") && consumerPrograms.has(expression)) step = "consumer";
      else unknownConsumer = true;
    }
    if (step) {
      if (event.outcome?.kind !== "exited" || !Number.isInteger(event.outcome.exitCode)) return {};
      pipelineCandidates.push({ step, executionId: event.executionId, exitCode: event.outcome.exitCode, rawRef: retain(`pipeline-${pipelineCandidates.length}.json`, { event, rawRefs: trace.rawRefs }) });
    }
  }
  // An image's actual exit still does not bind bytes at exec, cwd or artifact transitions.
  // No caller-supplied "verified" record can fill this missing OS instrumentation.
  return unknownConsumer && !pipelineCandidates.some(value => value.step === "consumer") ? {} : { pipelineCandidates, availability: "unavailable", requiredCapability: "Trusted exec-time executable/script identity, cwd, per-exec exits and build/archive/install/consumer artifact bindings" };
}

export const sourceObservations = { observe: observeSource };

export function observeSource({ check, fixture, trace, restart, sourceBefore, reviews, checkpoints, retain, readArtifact }) {
  const root = fixture.actorView.root;
  const files = listRegularFiles(root);
  let state;
  try { state = readSourceState({ root, files, baseCommit: fixture.gitSeed.baseCommit, retain: (name, value) => retain(`${check.id}-${name}`, value) }); }
  catch (error) {
    if (error.code !== "CHECK_SOURCE_IDENTITY_UNAVAILABLE") throw error;
    const rawRef = retain(`${check.id}-source-failure.json`, { code: error.code, root, files });
    return { availability: "observed", rawRefs: [rawRef], sourceFailure: { code: error.code, rawRef } };
  }
  const { sourceCommit, status, committer: { name, email } } = state;
  const nonGit = entries => entries.filter(file => !file.path.startsWith(".git/"));
  const changed = canonicalJson(nonGit(files)) !== canonicalJson(nonGit(sourceBefore));
  const sourceRef = state.rawRef;
  const common = {
    rawRefs: [sourceRef, ...fixture.writeProbe ? [fixture.writeProbe.rawRef] : []], sourceCommit, source: state, gitSeed: fixture.gitSeed, expectedCommitter: fixture.gitSeed.committer, observedCommitter: { name, email },
    commitVerified: status === "" || ["installed_public_matrix", "trace_and_git_truth"].includes(check.expectation.mode) && status.split("\n").every(line => /^\?\? (dist\/|[^/]+\.tgz$)/.test(line)), sourceChanged: changed, traceCoverage: trace?.traceCoverage,
  };
  const observed = reviews.map(review => {
    try { return { ...review, value: JSON.parse(review.result.textResultForLlm) }; }
    catch { return { ...review, value: null }; }
  });
  const review = observed.find(value => value.turnIndex === 1);
  const rereview = observed.findLast(value => value.turnIndex === 2);
  switch (check.expectation.mode) {
    case "installed_public_matrix": {
      const archives = nonGit(files).filter(file => file.path.endsWith(".tgz"));
      if (archives.length !== 1) return common;
      const archive = inspectArchive({ root, archive: archives[0], sourceCommit, retain });
      return { ...common, archive, rawRefs: [...common.rawRefs, archive.rawRef] };
    }
    case "trace_and_git_truth":
      return { ...common, ...observePackagePipeline({ trace, retain }) };
    case "expected_dependency_failure": {
      const blocked = observed.find(value => value.turnIndex === 0);
      const failure = readReviewJson(blocked?.value?.rawRef, readArtifact);
      if (failure !== null) requireCondition(failure.sessionId === blocked?.sessionId && failure.sha === blocked?.value?.sha, "REVIEW_READBACK_CHANGED", "The dependency failure belongs to a different source or session");
      const dependencyMissing = failure?.failure?.code === "ENOENT";
      return { ...common, routeBound: dependencyMissing, phase: "review-blocked", reviewOutcome: dependencyMissing ? "unavailable" : "unknown", completion: blocked?.value?.completion };
    }
    case "independent_review_truth":
      return { ...common, review: reviewReadback(review, readArtifact) };
    case "canonical_identity_truth":
      return { ...common, ...restart, routeBound: !!restart, outcomeIdBefore: canonicalJson(restart?.task), outcomeIdAfter: canonicalJson(restart?.task), freshSessionObserved: checkpoints.length > 1 && checkpoints[0].sessionId !== checkpoints[1].sessionId };
    case "repair_and_rereview":
      return { ...common, review: reviewReadback(rereview, readArtifact) };
    case "preserve_counterexample": {
      requireCondition(trace, "TRACE_UNAVAILABLE", "Preservation requires the current OS trace");
      const authority = observeAuthority({ trace, root, probe: fixture.writeProbe.filename });
      const protectedGit = entries => entries.filter(file => /^(\.git\/(HEAD|config|packed-refs)$|\.git\/refs\/)/.test(file.path));
      return {
        ...common, availability: authority.unresolved || trace.traceCoverage !== "complete" ? "unavailable" : "observed", traceCoverage: trace.traceCoverage, sourceChanged: changed || authority.sourceWrite,
        target: check.expectation.target, targetVerified: !changed, checkpoint: check.expectation.checkpoint,
        // An actual positive write probe is retained by the confinement owner, never inferred from mode bits.
        writableTargetVerified: fixture.writableTargetVerified,
        remoteOrDefaultMutation: authority.authorityWrite || canonicalJson(protectedGit(files)) !== canonicalJson(protectedGit(sourceBefore)),
      };
    }
    case "target_truth": {
      requireCondition(trace, "TRACE_UNAVAILABLE", "Target challenges require OS execution evidence");
      const target = check.expectation.targetRelativePath;
      const candidate = trace.executions.some(event => event.result === "0" && (event.args.includes(path.join(root, target)) || event.args.includes(`"${target}"`)));
      const executions = [];
      for (const event of trace.executions) {
        if (event.result !== "0" || event.outcome?.kind !== "exited" || !Number.isInteger(event.outcome.exitCode)) continue;
        try {
          const match = /^("(?:[^"\\]|\\.)*"),\s*(\[.*\]),\s/.exec(event.args);
          const executable = JSON.parse(match?.[1]);
          const argv = JSON.parse(match?.[2]);
          if (![process.execPath, "/usr/bin/node", "/bin/node"].includes(executable) || argv.length !== 2 || typeof argv[1] !== "string") continue;
          // Relative argv alone is not target identity. A native cwd record or an absolute script operand is required.
          if (!path.isAbsolute(argv[1]) && event.cwd !== root) continue;
          const absolute = path.isAbsolute(argv[1]) ? argv[1] : path.join(event.cwd, argv[1]);
          const relative = relativeName(path.relative(root, absolute));
          const initial = sourceBefore.find(file => file.path === relative);
          const current = files.find(file => file.path === relative);
          if (!initial || !current || !relative.endsWith("/challenge.mjs")) continue;
          executions.push({ relativePath: relative, sourceSha256: current.sha256, initialSha256: initial.sha256, exitCode: event.outcome.exitCode, rawRef: retain(`${check.id}-target-exec-${executions.length}.json`, { event, initial, current, traceRefs: trace.rawRefs }) });
        } catch { /* An undecodable or out-of-root command cannot establish a target identity. */ }
      }
      const authority = observeAuthority({ trace, root, probe: fixture.writeProbe?.filename });
      const available = trace.traceCoverage === "complete" && !authority.unresolved && !authority.sourceWrite && executions.length === 1;
      return { ...common, challengeCandidate: candidate, subjectTarget: available ? executions[0] : null, availability: available ? "observed" : "unavailable", requiredCapability: available ? undefined : "Complete native execution/cwd and writer trace bound to the unchanged source-system target" };
    }
    default:
      return common;
  }
}
