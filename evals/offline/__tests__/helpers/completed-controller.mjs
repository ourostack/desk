import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReviewHandler } from "../../controller-callbacks.mjs";
import { jsonBytes, sha256 } from "../../core.mjs";
import { controllerFixture } from "./controller-fixture.mjs";
import { privateControllerFixture } from "./private-controller.mjs";

// This is an intentionally synthetic actor/reviewer transport. It performs real fixture edits
// and local archive operations to exercise the controller, not a native or paid campaign.
export async function completedControllerFixture(caseId, options = {}) {
  if (caseId === "private-recording-boundaries") return privateControllerFixture();
  let turn = -1;
  let f;
  const commands = [];
  const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 });
  const commit = root => { git(root, ["add", "."]); git(root, ["commit", "--quiet", "-m", "Source-test fixture repair"]); };
  const run = (command, args, cwd) => {
    const output = execFileSync(command, args, { cwd, encoding: "utf8", timeout: 15000, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, HOME: f.root } });
    commands.push([path.basename(command), ...args]);
    return output;
  };
  f = await controllerFixture(caseId, { judgeStatus: options.judgeStatus, reviewSha: ({ roles }) => git(roles.actor, ["rev-parse", "HEAD"]).trim(), send: async ({ roles }) => {
    turn++;
    const actor = roles.actor;
    if (caseId === "discussion-then-go" && turn === 1) {
      const filename = path.join(actor, "src/policy.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return value || 3;", "return value ?? 3;"));
      commit(actor);
    }
    if (caseId === "checker-is-enforced") {
      const filename = path.join(actor, "package.json");
      const value = JSON.parse(fs.readFileSync(filename));
      value.scripts.ci = "npm run test && npm run check";
      fs.writeFileSync(filename, JSON.stringify(value));
    }
    if (caseId === "packed-deliverable") {
      const filename = path.join(actor, "src/retry-policy.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return value || 3;", "return value ?? 3;"));
      const build = path.join(actor, "build.mjs");
      fs.writeFileSync(build, fs.readFileSync(build, "utf8").replace("dist/retry-policy.mjs", "dist/public-entry.mjs"));
      commit(actor);
      run("npm", ["run", "build"], actor);
      const archive = run("npm", ["pack", "--ignore-scripts", "--offline"], actor).trim();
      const consumer = path.join(f.root, "consumer");
      fs.mkdirSync(consumer);
      run("npm", ["install", path.join(actor, archive), "--ignore-scripts", "--offline"], consumer);
      run(process.execPath, ["--input-type=module", "-e", 'import { retryAttempts } from "packed-delivery-fixture"; console.log(retryAttempts(), retryAttempts(5), retryAttempts(0));'], consumer);
      const filename_ = path.join(f.opened.traceDirectories[0], "syscalls.4242");
      const rows = commands.map((argv, index) => {
        const pid = 4243 + index;
        fs.writeFileSync(path.join(f.opened.traceDirectories[0], `syscalls.${pid}`), `${index + 2}.1 execve(${JSON.stringify(argv[0] === "npm" ? "/usr/bin/npm" : process.execPath)}, ${JSON.stringify(argv)}, 0x0) = 0\n${index + 2}.2 +++ exited with 0 +++\n`);
        return `${index + 2}.0 fork() = ${pid}`;
      });
      fs.writeFileSync(filename_, ['1.0 execve("/native", ["native"], 0x0) = 0', ...rows, '9.0 exit_group(0) = ?', '9.1 +++ exited with 0 +++'].join("\n") + "\n");
    }
    if (caseId === "review-recovery-state" && turn === 2) {
      const filename = path.join(actor, "quote.mjs");
      fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("return itemTotal([...items, delivery], discount);", "return items.length === 0 ? 0 : itemTotal(items, discount) + delivery;"));
      commit(actor);
    }
    if (caseId === "capability-probe-authority") {
      const challenge = path.join(actor, "approved/challenge.mjs");
      run(process.execPath, [challenge], actor);
      // The synthetic trace records the operand the fixture really executed, so target identity is absolute.
      fs.writeFileSync(path.join(f.opened.traceDirectories[0], "syscalls.4242"), `1.0 execve("/native", ["native"], 0x0) = 0\n2.0 execve(${JSON.stringify(process.execPath)}, ${JSON.stringify([process.execPath, challenge])}, 0x0) = 0\n3.0 exit_group(0) = ?\n3.1 +++ exited with 0 +++\n`);
    }
  } });
  if (caseId === "review-recovery-state") f.input.reviewHandler = syntheticReviewHandler(f);
  return f;
}

// The installed review policy really runs here over synthetic reviewer exports: the scoped executable is genuinely
// absent for the blocked turn, the measured bytes are restored to the same path afterwards, and the handler retains
// its execution, admission and reviewer-session records through the controller's own retention so the controller can
// reread and hash-verify every reference. No reviewer process, credential or provider is involved.
function syntheticReviewHandler(f) {
  const parentDir = path.join(f.root, "review");
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
