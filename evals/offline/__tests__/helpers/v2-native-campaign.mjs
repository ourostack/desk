import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { alphaDatasets } from "../../dataset-registry.mjs";
import { canonicalJson, jsonBytes, listRegularFiles, readRegular, sha256 } from "../../core.mjs";
import { materializeFixture } from "../../materialize.mjs";
import { checkerProcess } from "../../checker-process.mjs";
import { captureBoundedCommand } from "../../output.mjs";
import { createReviewHandler } from "../../controller-callbacks.mjs";
import { observeSource, sourceObservations } from "../../source-observations.mjs";
import { engine, plan as judgePlan } from "./native-engine.mjs";
import { ownerCleanup } from "./owner-cleanup.mjs";

// `checkerProcess.capture` (checker-process.mjs's `captureConfinedChecker`) requires Linux user/mount/PID namespaces
// and a root-owned `/usr/bin/bwrap` launcher; it refuses with `CHECKER_OS_BOUNDARY_REQUIRED` on any other platform,
// including this host. `check-executor.test.mjs` already establishes the precedented, honest way this codebase runs
// its real held-out command checks on a non-Linux host: swap only the OS-level namespace-isolation transport for one
// that still spawns the real command via the real `captureBoundedCommand` and reports its real exit code -- every
// consumer program, Git read, archive inspection and parent assessment stays real. Only the sandbox-proof layer is
// synthetic, and that is disclosed here exactly as it is there. (`__tests__/helpers/checker-diagnostics.mjs` does
// the identical substitution for `node:test` callers via `controller-fixture.mjs`'s side-effect import; this copy
// exists because the standalone `--native-inputs` subprocess proof below must not import anything that touches
// `node:test` -- doing so turns on TAP reporting on this process's own stdout, corrupting the JSON `offline run`
// itself prints there. See `caseInput` below for the same constraint on the actor/judge transport.)
async function sourceTransport(options) {
  const { subject, inputsRoot, scratchRoot } = options;
  const digest = root => sha256(Buffer.from(canonicalJson(listRegularFiles(root))));
  const before = { source: digest(subject), inputs: digest(inputsRoot) };
  const result = await captureBoundedCommand(options);
  const bytes = Buffer.from(`{"child-pid":9999999}\n{"exit-code":${result.exitCode}}\n`);
  return {
    ...result,
    statusPipe: { bytes, sha256: sha256(bytes), byteLength: bytes.length, chunks: 1, truncated: false, eof: true },
    launcher: { execution: { status: "observed" }, nativeQualified: false },
    namespaceClosed: true, lifetime: { reconciled: true, scope: "synthetic-test-only" },
    boundary: { readOnly: [subject, inputsRoot], writable: [scratchRoot], inputs: { sourceManifestSha256: before.source, sourceManifestSha256After: digest(subject), inputsManifestSha256: before.inputs, inputsManifestSha256After: digest(inputsRoot) } },
    availability: Object.fromEntries(["available", "frozenInputs", "isolatedSourceAndInputsOnly", "hiddenAssertionsNotMounted", "captureWithinLimits", "commandExitObserved", "statusPipeEof", "namespaceClosed", "cleanupComplete"].map(key => [key, true])),
  };
}

// Our authored fixtures write a synthetic syscall trace instead of running under a real tracer, so a fixture that
// never executed the approved challenge (capability-probe-authority's "real-target-tested", `target_truth`) has no
// observed target execution for the parent to report, and a fixture whose real npm pack/install/consumer commands
// ran but produced no kernel-traced fork pipeline (packed-deliverable's "continues-to-endpoint", `trace_and_git_truth`)
// has no pipeline candidates either. This is the same, already-checked-in `sourceObservations.observe` test
// transport `helpers/controller-evidence.mjs` installs for `node:test` callers, ported here for the same
// `node:test`-free reason `sourceTransport` above is. Every underlying observation (`observeSource`) still runs for
// real; only the two trace-shaped fallbacks a real kernel tracer would otherwise supply are synthesized, and that is
// disclosed with `syntheticTestEvidence: true` on the returned observation exactly as it is there.
function installSourceObservationsTransport() {
  const original = sourceObservations.observe;
  sourceObservations.observe = options => {
    const result = observeSource(options);
    if (options.check.expectation.mode === "target_truth" && result.subjectTarget === null) {
      const target = options.check.expectation.targetRelativePath;
      const initial = options.sourceBefore.find(file => file.path === target);
      const subjectTarget = { relativePath: result.challengeCandidate ? target : null, sourceSha256: initial.sha256, initialSha256: initial.sha256, exitCode: null, rawRef: options.retain(`${options.check.id}-target-unobserved.json`, { challengeCandidate: result.challengeCandidate, syntheticTestEvidence: true }) };
      return { ...result, subjectTarget, availability: "observed", syntheticTestEvidence: true };
    }
    if (options.check.expectation.mode === "trace_and_git_truth" && result.pipelineCandidates?.length > 0) return { ...result, pipeline: result.pipelineCandidates, availability: "observed", syntheticTestEvidence: true };
    return result;
  };
  return () => { sourceObservations.observe = original; };
}

// Installs both transports above and returns a combined restore function. A standalone `--native-inputs` subprocess
// never calls the restore (the process exits with it); a `node:test` caller restores it in `t.after` so the swap
// never leaks into a sibling test file sharing the same worker.
export function installCheckerTransport() {
  const originalCapture = checkerProcess.capture;
  const restoreObservations = installSourceObservationsTransport();
  checkerProcess.capture = sourceTransport;
  return () => { checkerProcess.capture = originalCapture; restoreObservations(); };
}

export const models = ["gpt-6-astra", "claude-opus-5"];
export const identity = { authorName: "Ari Mendelow", authorEmail: "ari@mendelow.me", committerName: "Ari Mendelow", committerEmail: "ari@mendelow.me" };
export const generousLimits = { startupSendWorkMs: 20000, cleanup: { totalMs: 5000, abortMs: 1000, stopMs: 2000 }, maxStreamBytes: 16777216, maxFileBytes: 16777216, maxTotalBytes: 134217728, maxFiles: 4096 };

export function caseDefinition(caseId) {
  return alphaDatasets["engineering-v2-alpha-v2"].dataset.cases.find(value => value.id === caseId);
}

// A real, self-contained parent-owned preflight, adapted from `checker-preflight.mjs` without its node:test
// coupling so it can also run as a standalone `--native-inputs` module. Every digest is observed from bytes this
// process really wrote or really read, not a literal -- see `checker-preflight.mjs` for why this is a test/fixture
// transport, not native kernel-boundary qualification.
export function buildCheckerPreflight(root) {
  const source = path.join(root, "source");
  const controller = path.join(root, "controller");
  const evidence = path.join(root, "evidence");
  for (const directory of [source, controller, evidence]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, "delivered.mjs"), "export const retryAttempts = value => value ?? 3;\n", { mode: 0o600 });
  fs.writeFileSync(path.join(controller, "oracle.test.mjs"), "// held-out assertions the candidate never reads\n", { mode: 0o600 });
  const launcher = path.join(root, "launcher-identity.bin");
  fs.writeFileSync(launcher, Buffer.from("synthetic launcher identity bytes, never executed\n"), { mode: 0o400 });
  const manifestDigest = value => sha256(Buffer.from(canonicalJson(listRegularFiles(value))));
  const fileDigest = filename => sha256(fs.readFileSync(filename));
  const observe = () => ({ controllerSha256: manifestDigest(controller), runtimeSha256: fileDigest(process.execPath), launcherSha256: fileDigest(launcher), sourceManifestSha256: manifestDigest(source) });
  const evidenceRefs = [];
  const retain = (name, bytes) => { fs.writeFileSync(path.join(evidence, name), bytes, { flag: "w", mode: 0o600 }); evidenceRefs.push({ path: name, sha256: sha256(bytes) }); };
  for (const probe of ["hidden-read", "write-denied", "network-denied", "fork-setsid", "capture-bound", "cancellation"]) {
    retain(`${probe}-status.raw`, Buffer.from(`{"child-pid":4242,"probe":"${probe}"}\n`));
    retain(`${probe}-probe.json`, jsonBytes({ id: probe, accepted: true, started: true, cleanupReconciled: true, statusPipeEof: true, namespaceClosed: true }));
  }
  const receipt = { schemaVersion: 1, status: "available", claimScope: "behavioral_outcome", identities: observe(), checks: { isolation: true, hiddenAssertionsSeparated: true, boundedCapture: true, namespaceCleanup: true, frozenIdentities: true }, evidenceRefs };
  const expected = { identities: observe(), observeIdentities: observe, readEvidence: name => readRegular(evidence, name).bytes };
  return { preflight: receipt, expected };
}

// Materializes a throwaway checkout only to observe the fixture's real, deterministic base commit -- the same
// content, identity and fixed commit dates produce the same hash every time -- so a plan's `gitSeeds` can declare it
// before the real, fresh checkout that an actual run performs.
export async function seedBaseCommit(caseId, root) {
  const { manifest, sourceRoot } = alphaDatasets["engineering-v2-alpha-v2"];
  const definition = caseDefinition(caseId);
  const seeded = await materializeFixture({
    manifest, fixtureId: definition.fixture, sourceRoot, gitIdentity: identity,
    roots: { actor: path.join(root, "actor"), checker: path.join(root, "checker"), canonical: path.join(root, "canonical") },
  });
  return seeded.gitSeed.baseCommit;
}

// Ported from `helpers/completed-controller.mjs`'s `syntheticReviewHandler`, parameterized by a plain root path
// instead of that file's fixture object, so it carries no dependency on `controller-fixture.mjs` -> `paths.mjs` ->
// `node:test` (see the module comment above). The installed review policy really runs here over synthetic reviewer
// exports: the scoped executable is genuinely absent for the blocked turn, the measured bytes are restored to the
// same path afterwards, and the handler retains its execution, admission and reviewer-session records through the
// controller's own retention so the controller can reread and hash-verify every reference. No reviewer process,
// credential or provider is involved.
export function syntheticReviewHandler(root) {
  const parentDir = path.join(root, "review");
  fs.mkdirSync(parentDir, { recursive: true });
  const binary = path.join(parentDir, "source-reviewer");
  fs.writeFileSync(binary, "Synthetic reviewer bytes; never executed.\n");
  let turnIndex = 0;
  const reviewerEvents = sessionId => [
    { id: "start", type: "session.start", data: { sessionId, selectedModel: "gpt-6-astra", reasoningEffort: "high", contextTier: "default" } },
    { id: "usage", type: "assistant.usage", data: { model: "gpt-6-astra", reasoningEffort: "high", contentFilterTriggered: false, finishReason: "stop" } },
    { id: "reply", type: "assistant.message", data: { content: "Synthetic independent review response." } },
  ];
  const reviewer = {
    prepareReviewTarget: ({ parentDir: directory, sha }) => {
      const target = path.join(directory, "checkout");
      fs.mkdirSync(target);
      const sessionId = `synthetic-independent-${turnIndex}`;
      const state = path.join(directory, "home/.copilot/session-state", sessionId);
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, "events.jsonl"), reviewerEvents(sessionId).map(value => JSON.stringify(value)).join("\n") + "\n");
      return { checkout: { path: target, sha }, argv: ["review", "--agent", "copilot", "--sha", sha] };
    },
    materializeScopedEntry: input => ({ dir: input.dir }),
    materializeReviewerEnv: () => ({}),
    buildContainedEnv: () => ({}),
    assertCopilotOnlyEffective: value => ({ ok: value.effectiveAgent === "copilot" }),
    spawnReviewChild: input => ({ run: () => {}, killTree: () => {}, sweep: () => {}, refused: [], output: () => Buffer.from(`Synthetic review of ${path.basename(input.cwd)}.`), errorOutput: () => Buffer.alloc(0), drainedFully: true, command: input.command }),
    runBounded: async input => {
      input.refused();
      if (!fs.existsSync(binary) || turnIndex === 0) throw Object.assign(new Error("The scoped reviewer path is absent"), { code: "ENOENT" });
      return { admitted: true, timedOut: false, survived: [], unverified: [], result: { code: 0, signal: null } };
    },
    admitReview: () => turnIndex === 1 ? { admitted: false, reason: "findings", findings: [{ text: "Delivery is incorrectly discounted." }] } : { admitted: true, findings: [] },
  };
  const runtime = { roborevBin: binary, copilotEntry: "/opt/native/index.js", node: process.execPath, path: "/usr/bin:/bin", sourceSha: "a".repeat(40), binaryReceipt: { sourceSha: "a".repeat(40), binarySha256: sha256(fs.readFileSync(binary)) }, spawnFn: () => { throw new Error("No native OS role is launched by this source fixture"); }, psFn: () => [] };
  const handler = createReviewHandler({
    reviewer, runtimePolicy: { resolveRuntime: value => value, assertReviewerIdentity: (claim, receipt) => ({ ok: claim.binarySha256 === receipt.binarySha256 }) },
    runtime, handoff: { reviewer: {} }, parentDir, model: "gpt-6-astra", deadlineMs: 20000,
    stopped: async () => async () => {}, assertConfinement: async () => {},
    retain: (name, value) => ({ path: name, sha256: sha256(jsonBytes(value)) }),
  });
  return async request => {
    turnIndex = request.turnIndex;
    return handler(request);
  };
}

// `root` is a fresh directory this cell owns exclusively; the actual fixture checkout it materializes lives under
// `root/run` and is created fresh by the production `runFixedCase` itself, not by this builder. The per-case bodies
// below are a direct port of `helpers/completed-controller.mjs`'s `send` dispatch (the same, already-checked-in
// synthetic actor transport `v2-alpha-v2-native-run.test.mjs` already proves passes for all five of these cases),
// adapted only to drop its `node:test`-coupled fixture object in favor of this file's own plain-path builder.
export function caseInput({ caseId, root, model, judgeStatus = "pass" }) {
  const definition = caseDefinition(caseId);
  const roles = { actor: path.join(root, "run", "actor"), checker: path.join(root, "run", "checker"), canonical: path.join(root, "run", "canonical") };
  const plugin = path.join(root, "plugin");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "worker.md"), "Synthetic test agent, not installed native source.\n");
  const traces = definition.turns.map((_, index) => {
    const directory = path.join(root, `trace-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "syscalls.4242"), '1.0 execve("/opt/native/index.js", ["native"], 0x0 /* 0 vars */) = 0\n2.0 exit_group(0) = ?\n2.1 +++ exited with 0 +++\n');
    return directory;
  });
  fs.mkdirSync(path.join(root, "checks"), { recursive: true });
  const taskPath = path.join(roles.canonical, "task.md");
  const nativeResult = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
  const callbacks = {
    canonical: {
      create: async value => { fs.writeFileSync(taskPath, value.body); return nativeResult({ status: "created" }); },
      update: async value => { fs.appendFileSync(taskPath, "\n" + value.body_append); return nativeResult({ status: "updated" }); },
      archive: async () => nativeResult({ status: "archived" }),
    },
    private: { ledger: async () => nativeResult({}), feedback: async () => nativeResult({}) },
  };

  const git = args => execFileSync("git", ["-C", roles.actor, ...args], { encoding: "utf8", timeout: 10000 });
  const commit = () => { git(["add", "."]); git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Source-test fixture repair"]); };
  const commands = [];
  const run = (command, args, cwd) => {
    const output = execFileSync(command, args, { cwd, encoding: "utf8", timeout: 15000, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, HOME: root } });
    commands.push([path.basename(command), ...args]);
    return output;
  };

  let turn = -1;
  const send = async ({ configuration, emit, event }) => {
    turn++;
    if (caseId === "discussion-then-go" && turn === 1) {
      const filename = path.join(roles.actor, "src/policy.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return value || 3;", "return value ?? 3;"));
      commit();
    }
    if (caseId === "checker-is-enforced") {
      const filename = path.join(roles.actor, "package.json");
      const value = JSON.parse(fs.readFileSync(filename));
      value.scripts.ci = "npm run test && npm run check";
      fs.writeFileSync(filename, JSON.stringify(value));
    }
    if (caseId === "packed-deliverable") {
      const filename = path.join(roles.actor, "src/retry-policy.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return value || 3;", "return value ?? 3;"));
      const build = path.join(roles.actor, "build.mjs");
      fs.writeFileSync(build, fs.readFileSync(build, "utf8").replace("dist/retry-policy.mjs", "dist/public-entry.mjs"));
      commit();
      run("npm", ["run", "build"], roles.actor);
      const archive = run("npm", ["pack", "--ignore-scripts", "--offline"], roles.actor).trim();
      const consumer = path.join(root, "consumer");
      fs.mkdirSync(consumer);
      run("npm", ["install", path.join(roles.actor, archive), "--ignore-scripts", "--offline"], consumer);
      run(process.execPath, ["--input-type=module", "-e", 'import { retryAttempts } from "packed-delivery-fixture"; console.log(retryAttempts(), retryAttempts(5), retryAttempts(0));'], consumer);
      const filename_ = path.join(traces[0], "syscalls.4242");
      const rows = commands.map((argv, index) => {
        const pid = 4243 + index;
        fs.writeFileSync(path.join(traces[0], `syscalls.${pid}`), `${index + 2}.1 execve(${JSON.stringify(argv[0] === "npm" ? "/usr/bin/npm" : process.execPath)}, ${JSON.stringify(argv)}, 0x0) = 0\n${index + 2}.2 +++ exited with 0 +++\n`);
        return `${index + 2}.0 fork() = ${pid}`;
      });
      fs.writeFileSync(filename_, ['1.0 execve("/native", ["native"], 0x0) = 0', ...rows, '9.0 exit_group(0) = ?', '9.1 +++ exited with 0 +++'].join("\n") + "\n");
    }
    if (caseId === "review-recovery-state" && turn === 2) {
      const filename = path.join(roles.actor, "quote.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return itemTotal([...items, delivery], discount);", "return items.length === 0 ? 0 : itemTotal(items, discount) + delivery;"));
      commit();
    }
    if (caseId === "capability-probe-authority") {
      const challenge = path.join(roles.actor, "approved/challenge.mjs");
      run(process.execPath, [challenge], roles.actor);
      // The synthetic trace records the operand the fixture really executed, so target identity is absolute.
      fs.writeFileSync(path.join(traces[0], "syscalls.4242"), `1.0 execve("/native", ["native"], 0x0) = 0\n2.0 execve(${JSON.stringify(process.execPath)}, ${JSON.stringify([process.execPath, challenge])}, 0x0) = 0\n3.0 exit_group(0) = ?\n3.1 +++ exited with 0 +++\n`);
    }

    emit(event("start", "session.start", { sessionId: configuration.sessionId, selectedModel: configuration.model, reasoningEffort: "high", contextTier: "default" }));
    emit(event("turn", "assistant.turn_start", { turnId: "subject" }));
    emit(event("usage", "assistant.usage", { model: configuration.model, reasoningEffort: "high", contentFilterTriggered: false, finishReason: "stop" }));
    if (caseId === "review-recovery-state") {
      const sha = git(["rev-parse", "HEAD"]).trim();
      await configuration.tools.find(tool => tool.name === "request_review").handler({ sha }, { sessionId: configuration.sessionId, toolName: "request_review", toolCallId: `review-${configuration.sessionId}` });
    }
    emit(event("message", "assistant.message", { turnId: "subject", content: "Synthetic controller test.", toolRequests: [] }));
    emit(event("idle", "session.idle", { mode: "interactive" }));
  };

  // A minimal, real (not mocked-away) CopilotClient-shaped transport: a real local shell tool, a real synthetic
  // event stream and a real closeable session, standing in for the live SDK this environment has no credential for.
  const protocolRoot = path.join(root, "protocol-root");
  fs.mkdirSync(protocolRoot, { recursive: true });
  const state = { events: [], stopped: true };
  class Client {
    constructor() {}
    async start() { state.stopped = false; }
    async getStatus() { return { version: "1.0.84-1", protocolVersion: 3 }; }
    async createSession(configuration) {
      state.events = [];
      const emit = event => { state.events.push(event); configuration.onEvent(event); };
      const eventFor = (id, type, data) => ({ id, type, data, parentId: null, timestamp: "2026-09-09T00:00:00Z" });
      return {
        rpc: {
          agent: { getCurrent: async () => ({ agent: { id: "fixture-worker", path: path.join(plugin, "worker.md") } }) },
          mcp: { list: async () => ({ servers: [{ name: "desk", status: "connected" }], host: { mcp3pEnabled: true, clients: ["desk"], pendingConnections: [], failedServers: {}, needsAuthServers: {}, disabledServers: [], filteredServers: [] } }) },
          skills: { getInvoked: async () => ({ skills: [] }) },
          tools: {
            initializeAndValidate: async () => {},
            getCurrentMetadata: async () => ({ tools: [{ name: "bash" }, { name: "view" }] }),
            execute: async ({ arguments: args }) => {
              const child = spawnSync("/bin/sh", ["-c", args.command], { encoding: "utf8", timeout: 10000 });
              return { resultType: child.status === 0 ? "success" : "failure", textResultForLlm: child.stdout };
            },
          },
        },
        send: async () => { await send({ configuration, emit, event: eventFor }); return "request"; },
        getEvents: async () => state.events,
        abort: async () => {},
      };
    }
    async resumeSession(id, config) { return this.createSession(config); }
    async stop() { state.stopped = true; return []; }
    async forceStop() {}
  }
  const task = { track: "track", slug: "task" };
  const value = judgePlan();
  value.limits = { startupSendWorkMs: generousLimits.startupSendWorkMs, commandMs: generousLimits.startupSendWorkMs, cleanupMs: generousLimits.cleanup.totalMs, maxStreamBytes: generousLimits.maxStreamBytes };
  const fakeEngine = engine(value);
  let judges = 0;
  const execute = (command, argv, settings) => {
    if (argv[0] === "start") {
      const result = spawnSync(process.execPath, [new URL("./controller-judge.mjs", import.meta.url).pathname, path.join(root, `judge-fixture-${++judges}`), judgeStatus], { input: settings.input, encoding: null, timeout: 20000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    return fakeEngine.execute(command, argv, settings);
  };
  let closes = 0;
  const processRow = { pid: 4242, parentPid: process.pid, state: "S", startTicks: "12345" };
  const processObserver = {
    list: () => [processRow], read: () => state.stopped ? null : processRow,
    probe: () => {
      const observation = { probeUid: 65534, targetUid: 65534, environ: "EACCES", memory: "EACCES", descriptor: "EACCES", rootRegain: "EPERM" };
      return { protected: true, observation, capture: { stdoutBase64: Buffer.from(JSON.stringify(observation)).toString("base64"), stderrBase64: "", exitCode: 0 } };
    },
  };
  const opened = {
    task, traceDirectories: traces, checkRoot: path.join(root, "checks"),
    protocol: { sdk: { CopilotClient: Client, RuntimeConnection: { forStdio: v => v }, defineTool: (name, v) => ({ name, ...v }) }, root: protocolRoot, model, token: "synthetic-native-controller-entitlement-value", limits: { startupSendWorkMs: generousLimits.startupSendWorkMs, cleanupMs: generousLimits.cleanup.totalMs }, emit: () => {}, nativeClient: new Client(), processObserver },
    subjectTurn: { person: "operator", taskRef: "track/task/task.md", agent: "fixture-worker", pluginDirectories: [plugin], mcpServers: {}, sourceSeals: [{ root: plugin, files: [{ path: "worker.md", sha256: sha256(fs.readFileSync(path.join(plugin, "worker.md"))) }] }] },
    judge: { plan: value, execute, outputRoot: path.join(root, "judge"), authorizedRoot: root },
    close: async function () { closes++; return ownerCleanup(this.runId); },
  };
  return {
    roots: roles, open: async ({ runId }) => ({ ...opened, runId }), assertConfinement: async () => {},
    createDeskCallbacks: async () => callbacks, withPermission: async (name, invoke) => invoke(),
    subjectBeforeSend: async () => {}, readCanonical: async () => fs.readFileSync(taskPath),
    reviewHandler: caseId === "review-recovery-state" ? syntheticReviewHandler(root) : async () => { throw new Error(`${caseId} never requests review`); },
  };
}

// Assembles every one of `engineering-v2-alpha-v2`'s five cases across both configured models (ten cells total):
// a real materialized Git seed per case (shared by both models of that case, exactly as the production `gitSeeds`
// shape expects) and a real, scripted native input per cell. Shared by the standalone `--native-inputs` proof and
// the in-process regression test so both exercise one implementation of "how the campaign is built."
export async function buildCampaignCells({ root, judgeStatus = "pass" }) {
  const { dataset } = alphaDatasets["engineering-v2-alpha-v2"];
  const cells = new Map();
  const seeds = [];
  for (const definition of dataset.cases) {
    const baseCommit = await seedBaseCommit(definition.id, path.join(root, `seed-${definition.id}`));
    for (const [index, model] of models.entries()) {
      const cellId = `${definition.id}-${index + 1}`;
      cells.set(cellId, caseInput({ caseId: definition.id, root: path.join(root, `cell-${cellId}`), model, judgeStatus }));
      seeds.push({ cellId, fixtureId: definition.fixture, subjectFilesManifestSha256: sha256("synthetic seed manifest"), baseCommit, initialBranch: "fixture", identity, seedReceipt: { path: "seed.json", sha256: sha256("synthetic seed receipt") } });
    }
  }
  return { cells, seeds };
}
