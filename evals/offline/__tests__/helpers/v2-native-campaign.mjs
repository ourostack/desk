import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { alphaDatasets } from "../../dataset-registry.mjs";
import { canonicalJson, jsonBytes, listRegularFiles, readRegular, sha256 } from "../../core.mjs";
import { materializeFixture } from "../../materialize.mjs";
import { checkerProcess } from "../../checker-process.mjs";
import { captureBoundedCommand } from "../../output.mjs";
import { engine, plan as judgePlan } from "./native-engine.mjs";
import { ownerCleanup } from "./owner-cleanup.mjs";

// `checkerProcess.capture` (checker-process.mjs's `captureConfinedChecker`) requires Linux user/mount/PID namespaces
// and a root-owned `/usr/bin/bwrap` launcher; it refuses with `CHECKER_OS_BOUNDARY_REQUIRED` on any other platform,
// including this host. `check-executor.test.mjs` already establishes the precedented, honest way this codebase runs
// its real held-out command checks on a non-Linux host: swap only the OS-level namespace-isolation transport for one
// that still spawns the real command via the real `captureBoundedCommand` and reports its real exit code -- every
// consumer program, Git read, archive inspection and parent assessment stays real. Only the sandbox-proof layer is
// synthetic, and that is disclosed here exactly as it is there.
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

// Installs the transport above and returns a restore function. A standalone `--native-inputs` subprocess never
// calls the restore (the process exits with it); a `node:test` caller restores it in `t.after` so the swap never
// leaks into a sibling test file sharing the same worker.
export function installCheckerTransport() {
  const original = checkerProcess.capture;
  checkerProcess.capture = sourceTransport;
  return () => { checkerProcess.capture = original; };
}

// A genuine, real, self-contained native input for one `engineering-v2-alpha-v2` "discussion-then-go" cell: a
// synthetic SDK/judge transport standing in for a live Copilot CLI/model session -- "the fixed controller" fixture
// mode this repository's own test suite already relies on -- but with no node:test coupling (no `workRoot`/`after`),
// so the exact same builder can run either inside the test suite or as a standalone `--native-inputs` module loaded
// by a real `offline run` subprocess. It performs real fixture materialization, a real local Git commit and a real
// spawned checker/judge process; it is not a live model session and never claims to be one.
//
// It exercises exactly one of `engineering-v2-alpha-v2`'s five retained cases. The other four are not scripted here
// (there is no live-model credential in this environment to drive them, per the fixed-controller fallback this
// dataset's cases already document) -- a caller that needs the full campaign structurally represented, without
// fabricating cell results, pairs this with `unscriptedInput` for every other expected cell.
export const identity = { authorName: "Ari Mendelow", authorEmail: "ari@mendelow.me", committerName: "Ari Mendelow", committerEmail: "ari@mendelow.me" };
export const generousLimits = { startupSendWorkMs: 20000, cleanup: { totalMs: 5000, abortMs: 1000, stopMs: 2000 }, maxStreamBytes: 16777216, maxFileBytes: 16777216, maxTotalBytes: 134217728, maxFiles: 4096 };

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

export function discussionThenGoDefinition() {
  return alphaDatasets["engineering-v2-alpha-v2"].dataset.cases.find(value => value.id === "discussion-then-go");
}

// Materializes a throwaway checkout only to observe the fixture's real, deterministic base commit -- the same
// content, identity and fixed commit dates produce the same hash every time -- so a plan's `gitSeeds` can declare it
// before the real, fresh checkout that an actual run performs.
export async function seedBaseCommit(root) {
  const { manifest, sourceRoot } = alphaDatasets["engineering-v2-alpha-v2"];
  const definition = discussionThenGoDefinition();
  const seeded = await materializeFixture({
    manifest, fixtureId: definition.fixture, sourceRoot, gitIdentity: identity,
    roots: { actor: path.join(root, "actor"), checker: path.join(root, "checker"), canonical: path.join(root, "canonical") },
  });
  return seeded.gitSeed.baseCommit;
}

// A structurally valid but never-invoked input for a cell this builder does not script. `requireNativeInputs`
// requires every expected cell to carry real functions; without a mapped Git seed, `runFixedCase` refuses the cell
// with `NATIVE_SEED_UNMAPPED` before any of these functions is ever called, so a campaign that reaches one honestly
// reports it unavailable rather than silently omitting or fabricating it.
export function unscriptedInput() {
  const refuse = name => async () => { throw new Error(`${name} must not run: this cell has no mapped native Git seed`); };
  return {
    roots: {}, open: refuse("open"), assertConfinement: refuse("assertConfinement"), readCanonical: refuse("readCanonical"),
    withPermission: refuse("withPermission"), createDeskCallbacks: refuse("createDeskCallbacks"),
    subjectBeforeSend: refuse("subjectBeforeSend"), reviewHandler: refuse("reviewHandler"),
  };
}

// `root` is a fresh directory this cell owns exclusively; the actual fixture checkout it materializes lives under
// `root/run` and is created fresh by the production `runFixedCase` itself, not by this builder.
export function discussionThenGoInput({ root, model, judgeStatus = "pass" }) {
  const definition = discussionThenGoDefinition();
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
  let turn = -1;
  const send = async ({ configuration, emit, event }) => {
    turn++;
    emit(event("start", "session.start", { sessionId: configuration.sessionId, selectedModel: configuration.model, reasoningEffort: "high", contextTier: "default" }));
    emit(event("turn", "assistant.turn_start", { turnId: "subject" }));
    emit(event("usage", "assistant.usage", { model: configuration.model, reasoningEffort: "high", contentFilterTriggered: false, finishReason: "stop" }));
    if (turn === 1) {
      const filename = path.join(roles.actor, "src/policy.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return value || 3;", "return value ?? 3;"));
      execFileSync("git", ["-C", roles.actor, "add", "."], { encoding: "utf8", timeout: 10000 });
      execFileSync("git", ["-C", roles.actor, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Source-test fixture repair"], { encoding: "utf8", timeout: 10000 });
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
    reviewHandler: async () => { throw new Error("discussion-then-go never requests review"); },
  };
}
